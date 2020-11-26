// -*- coding: utf-8 -*-
//===============================================================================
//
// Copyright (c) 2020 Chatopera Inc. <https://www.chatopera.com> All Rights Reserved
//
//
// Author: Hai Liang Wang
// Date: 2020-11-25:18:36:48
//
//===============================================================================
const facebookService = require('./facebook.service');
const debug = require('debug')('fmc:service:chat');
const chatbotService = require('./chatopera.service');
const _ = require('lodash');
const { User, AnswerComment } = require('../models');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const CONSTANTS = require('../miscs/constants');
const { getAccountByPageId } = require('../miscs/utils');

class ChatService {
  constructor(pageId, userId) {
    debug('chat service: pageId(%s), userId(%s)', pageId, userId);
    this.pageId = pageId;
    this.userId = userId;
    this.locale = CONSTANTS.DV_LOCALE;
    this.user = null;
    this.account = null;
  }

  async init() {
    this.facebook = facebookService.getInstance(this.pageId);
    // reload user from db
    this.user = await User.findById(this.userId).exec();

    // not found, or no locale present, force re-sync
    if (this.user?.locale) {
      debug('user or user locale not present, force re-sync ...');
      this.user = this.syncUserLocale(this.userId, false);
    }

    this.locale = this.user?.locale || CONSTANTS.DV_LOCALE;
    this.account = getAccountByPageId(config.accounts, this.pageId);
    this.chatbot = chatbotService.getInstance(this.pageId, this.locale);

    this.msgs = {
      GUESS_MSG: CONSTANTS.DV_GUESS_MSG,
      HELPFUL_MSG: CONSTANTS.DV_HELPFUL_MSG,
      HELPFUL_FEEDBACK_YES_BTN: CONSTANTS.DV_HELPFUL_FEEDBACK_YES_BTN,
      HELPFUL_FEEDBACK_NO_BTN: CONSTANTS.DV_HELPFUL_FEEDBACK_NO_BTN,
      CLICK_YES_MSG: CONSTANTS.DV_CLICK_YES_MSG,
      CLICK_NO_MSG: CONSTANTS.DV_CLICK_NO_MSG,
      ..._.get(this.account?.chatopera, this.locale)?.custom,
    };
  }

  query(senderId, key) {
    debug('user %s query %s on pageId(%s)', senderId, key, this.pageId);
    this.chatbotQuery(senderId, key).catch(console.error);
  }

  async syncUserLocale(psid, init = true) {
    let info = await this.facebook.getPersonProfile(psid);
    await User.findByIdAndUpdate(psid, { $set: info }, { upsert: true });
    if (init) await this.init();
    return info;
  }

  async chatbotQuery(senderId, msg, isFaqClick) {
    debug(' user %s query msg', senderId, msg);

    let kickoffResult = await this.chatbot.conversationQuery(
      senderId,
      msg,
      config.FAQ_BEST_REPLY_THRESHOLD,
      config.FAQ_SUGG_REPLY_THRESHOLD
    );

    if (kickoffResult.logic_is_fallback) {
      if (kickoffResult.faq?.length > 0) {
        let faq = _.take(kickoffResult.faq, 3);
        await this.facebook.sendButtonMessage(
          senderId,
          this.msgs.GUESS_MSG,
          _.map(faq, (f) => {
            return {
              type: 'postback',
              title: f.post,
              payload: `faq-${f.post}`,
            };
          })
        );
      }
    } else if (kickoffResult.string == '#in-params#') {
      for (let p of kickoffResult.params) {
        if (p.type == 'card') {
          await this.facebook.sendImageMessage(senderId, p.thumbnail);
        } else if (p.type == 'plain') {
          await this.facebook.sendTextMessage(senderId, p.text);
        }
      }
    } else if (kickoffResult.service?.provider == 'faq') {
      let resultMsg = kickoffResult.string + '\n\n' + this.msgs.HELPFUL_MSG;
      if (isFaqClick) {
        resultMsg = kickoffResult.service?.post + '\n\n' + resultMsg;
      }

      let yesId = uuidv4();
      let noId = uuidv4();
      let body = await this.facebook.sendButtonMessage(senderId, resultMsg, [
        {
          type: 'postback',
          title: this.msgs.HELPFUL_FEEDBACK_YES_BTN,
          payload: 'evaluate' + 'Y' + yesId,
        },
        {
          type: 'postback',
          title: this.msgs.HELPFUL_FEEDBACK_NO_BTN,
          payload: 'evaluate' + 'N' + noId,
        },
      ]);
      let _messageId = body.message_id;
      var answerComment = await AnswerComment.create({
        userId: senderId,
        pageId: this.pageId,
        messageId: _messageId,
        yesId: yesId,
        noId: noId,
        comment: '',
        status: false,
        docId: kickoffResult.service?.docId, //知识库问答对id
        question: kickoffResult.service?.post, //知识库问题
        answer: kickoffResult.string, //知识库答案
      });
      debug(answerComment);
    } else {
      await this.facebook.sendTextMessage(senderId, kickoffResult.string);
    }
  }

  async commentQuery(senderId, evaluationResults, YorNId) {
    debug(' user %s query evaluationResults', senderId, evaluationResults);
    if (evaluationResults == 'Y') {
      let yesData = await AnswerComment.findOne({ yesId: YorNId });
      if (yesData?.status == true) {
        debug('已评论过');
      } else {
        debug('正在评价Yes');
        await this.facebook.sendTextMessage(
          senderId,
          _.sample(this.msgs.CLICK_YES_MSG)
        );
        let doc = await AnswerComment.findOne({ yesId: YorNId }).exec();
        doc.comment = 'Yes';
        doc.status = true;
        await doc.save();
      }
    } else if (evaluationResults == 'N') {
      let noData = await AnswerComment.findOne({ noId: YorNId });
      if (noData?.status == true) {
        debug('已评论过');
      } else {
        debug('正在评价No');
        await this.facebook.sendTextMessage(
          senderId,
          _.sample(this.msgs.CLICK_NO_MSG)
        );
        let doc = await AnswerComment.findOne({ noId: YorNId }).exec();
        doc.comment = 'No';
        doc.status = true;
        await doc.save();
      }
    }
  }

  async openThreadQuery(senderId, ref) {
    debug('user %s query ref %s', senderId, ref);
    this.facebook.sendOnetimeNotReq(senderId, '请一定通知我呀', ref);
  }

  async openThreadOkQuery(senderId, ref, payloadData) {
    debug('user %s query msg', senderId, ref, payloadData);
    // 保存到数据库 payloadData为链接参数
    debug(payloadData);
    this.facebook.sendTextMessage(senderId, '感谢您的关注，上线之后会通知到您');
  }
}

exports.create = async (pageId, userId) => {
  let instance = new ChatService(pageId, userId);
  await instance.init();
  return instance;
};
