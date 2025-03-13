// bot.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// 初始化配置
const {
  TELEGRAM_BOT_TOKEN,
  GROUP_ID,
  USER_INFO_TOPIC_NAME,
  LOG_TOPIC_NAME,
  TELEGRAM_BOT_OWNER_ID
} = process.env;

// 初始化机器人
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// 存储结构
const userTopicMap = new Map(); // userID -> topicInfo
const topicUserMap = new Map(); // topicID -> userID
let USER_INFO_TOPIC_ID;
let LOG_TOPIC_ID;

// 确保备份目录存在
function ensureBackupDirs() {
  const backupDir = path.join(__dirname, 'backup', 'export');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
}

// 加载或创建话题
async function loadOrCreateTopic(topicName, fileName, initMessage) {
  const filePath = path.join(__dirname, fileName);
  let topicId;
  let created = false;

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length > 0) topicId = lines[0].trim();
    }

    if (!topicId) {
      const { message_thread_id } = await bot.createForumTopic(
        GROUP_ID,
        topicName,
        { icon_color: 0x6FB9F0 }
      );
      topicId = message_thread_id.toString();
      fs.writeFileSync(filePath, `${topicId}\n`, 'utf-8');
      // 使用动态生成的initMessage
      const messageText = typeof initMessage === 'function' ? initMessage(topicId) : initMessage;
      await bot.sendMessage(GROUP_ID, messageText, { message_thread_id: topicId });
      created = true;
    }
    return { topicId, created };
  } catch (error) {
    console.error(`处理 ${topicName} 话题失败:`, error);
    throw error;
  }
}

// 用户映射加载增强
function loadUserMappings() {
  const filePath = path.join(__dirname, 'user_info.txt');
  if (!fs.existsSync(filePath)) return;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    // 跳过第一行的话题ID
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('---');
      if (parts.length >= 2) {
        const [topicId, ...rest] = parts;
        const userId = rest.pop();
        const username = rest.join('---') || '';

        // 防止重复加载
        if (!userTopicMap.has(userId)) {
          userTopicMap.set(userId, { topicId, username });
          topicUserMap.set(topicId, userId);
        }
      }
    }
    console.log(`已加载 ${userTopicMap.size} 条用户映射`);
  } catch (error) {
    console.error('加载用户映射失败:', error);
  }
}

// 初始化函数
async function initialize() {
  try {
    ensureBackupDirs();
    console.log('正在初始化机器人...');

    // 验证群组信息
    const chat = await bot.getChat(GROUP_ID);
    if (chat.type !== 'supergroup') throw new Error('需要超级群组');
    if (!chat.is_forum) throw new Error('群组未开启论坛功能');

    // 初始化用户信息话题
    const userInfoTopicResult = await loadOrCreateTopic(
      USER_INFO_TOPIC_NAME,
      'user_info.txt',
      (topicId) => `用户信息话题初始化成功！话题ID: ${topicId}`
    );
    USER_INFO_TOPIC_ID = userInfoTopicResult.topicId;

    // 初始化日志话题
    const logTopicResult = await loadOrCreateTopic(
      LOG_TOPIC_NAME,
      'forwardlog.log',
      (topicId) => `日志话题初始化成功！话题ID: ${topicId}`
    );
    LOG_TOPIC_ID = logTopicResult.topicId;

    // 加载用户映射数据
    loadUserMappings(); // 新增的关键调用

    // 发送启动消息
    const startupMessage = userInfoTopicResult.created ? '✅ 初始化成功' : '✅ 机器人启动成功';
    await bot.sendMessage(GROUP_ID, startupMessage, {
      message_thread_id: USER_INFO_TOPIC_ID
    });

    // 新增：发送用户加载数量提示
    const loadedUsers = userTopicMap.size;
    const loadStatusMessage = loadedUsers > 0
      ? `📊 已加载用户数据：${loadedUsers} 条映射关系`
      : '⚠️ 未找到历史用户数据';
    await bot.sendMessage(GROUP_ID, loadStatusMessage, {
      message_thread_id: USER_INFO_TOPIC_ID,
      disable_notification: true
    });

  } catch (error) {
    console.error('初始化失败:', error);
    process.exit(1);
  }
}

// 创建新话题
async function createForumTopic(user) {
  try {

    const existing = userTopicMap.get(user.id.toString());
    if (existing) {
      console.log(`用户 ${user.id} 已存在，使用现有话题: ${existing.topicId}`);
      return existing.topicId;
    }
    const topicName = user.username ?
      `${user.username} --- ${user.id}` :
      `用户 --- ${user.id}`;

    const { message_thread_id } = await bot.createForumTopic(GROUP_ID, topicName);
    const topicId = message_thread_id.toString();

    // 记录到user_info.txt
    const userLine = user.username ?
      `${topicId}---${user.username}---${user.id}` :
      `${topicId}---${user.id}`;
    fs.appendFileSync(path.join(__dirname, 'user_info.txt'), `\n${userLine}`, 'utf-8');

    // createForumTopic 函数中的相关部分
    userTopicMap.set(user.id.toString(), { topicId, username: user.username || '' });
    topicUserMap.set(topicId, user.id.toString());

    // 发送确认信息
    await bot.sendMessage(GROUP_ID,
      `用户ID: ${user.id}\n话题ID: ${topicId}\n用户名: @${user.username || '无'}`, {
      message_thread_id: USER_INFO_TOPIC_ID
    });

    return topicId;
  } catch (error) {
    console.error('创建话题失败:', error);
    return null;
  }
}

// 记录日志
// 记录日志
function logEvent(eventType, from, to) {
  const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });

  // 处理来源信息
  let fromInfo;
  if (from.type === 'user') {
    const userStr = from.username ? `${from.username}(${from.id})` : from.id;
    fromInfo = eventType === '群组到用户' ? `群组用户 ${userStr}` : `用户 ${userStr}`;
  } else {
    fromInfo = '未知来源';
  }

  // 处理目标信息
  let toInfo;
  if (to.type === 'topic') {
    const userId = topicUserMap.get(to.id);
    const userInfo = userId ? userTopicMap.get(userId) : null;
    const topicName = userInfo
      ? (userInfo.username ? `${userInfo.username} --- ${userId}` : `用户 --- ${userId}`)
      : '未知话题';
    toInfo = `话题 ${to.id}(${topicName})`;
  } else if (to.type === 'user') {
    const userInfo = userTopicMap.get(to.id);
    const userStr = userInfo?.username ? `${userInfo.username}(${to.id})` : to.id;
    toInfo = `用户 ${userStr}`;
  } else {
    toInfo = '未知目标';
  }

  const logLine = `${timestamp} --- ${eventType}: ${fromInfo} 成功转发到 ${toInfo}\n`;
  fs.appendFileSync(path.join(__dirname, 'forwardlog.log'), logLine, 'utf-8');

  // 发送到日志话题
  if (LOG_TOPIC_ID) {
    bot.sendMessage(GROUP_ID, logLine.trim(), {
      message_thread_id: LOG_TOPIC_ID
    }).catch(error => {
      console.error('发送日志到日志话题失败:', error);
    });
  }
}

// 处理私聊消息
bot.on('message', async msg => {
  if (msg.chat.type !== 'private') return;

  const user = msg.from;
  const userKey = user.id.toString();

  try {
    let topicInfo = userTopicMap.get(userKey);
    if (!topicInfo) {
      const topicId = await createForumTopic(user);
      if (!topicId) return;
      topicInfo = { topicId, username: user.username || '' };
    }

    // 转发消息
    await bot.forwardMessage(GROUP_ID, msg.chat.id, msg.message_id, {
      message_thread_id: topicInfo.topicId
    });

    // 记录日志
    const fromUser = user.username ? `${user.username}(${user.id})` : user.id.toString();
    logEvent('用户到群组',
      { type: 'user', id: user.id, username: user.username || '' },
      { type: 'topic', id: topicInfo.topicId }
    );
  } catch (error) {
    console.error('处理私聊消息失败:', error);
  }
});

// 处理群组回复
bot.on('message', async msg => {
  if (msg.chat.id.toString() !== GROUP_ID) return;
  if (!msg.message_thread_id || msg.from?.is_bot) return;

  try {
    const topicId = msg.message_thread_id.toString();
    const userId = topicUserMap.get(topicId);

    if (userId) {
      await bot.copyMessage(userId, GROUP_ID, msg.message_id);

      // 记录日志
      const fromGroupUser = msg.from.username ? `${msg.from.username}(${msg.from.id})` : msg.from.id.toString();
      logEvent('群组到用户',
        { type: 'user', id: msg.from.id, username: msg.from.username || '' },
        { type: 'user', id: userId }
      );
    }
  } catch (error) {
    console.error('处理群组回复失败:', error);
  }
});

// 处理导出命令
bot.on('message', async msg => {
  if (msg.chat.id.toString() !== GROUP_ID || !msg.message_thread_id) return;
  if (msg.from.id.toString() !== TELEGRAM_BOT_OWNER_ID) return;

  try {
    const command = msg.text?.trim();
    const threadId = msg.message_thread_id.toString();

    if (threadId === USER_INFO_TOPIC_ID && command === '导出用户') {
      await exportFile('user_info.txt', '用户信息导出');
    } else if (threadId === LOG_TOPIC_ID && command === '导出日志') {
      await exportFile('forwardlog.log', '日志导出');
    }
  } catch (error) {
    console.error('处理导出命令失败:', error);
  }
});

// 导出文件处理
async function exportFile(fileName, exportType) {
  const sourcePath = path.join(__dirname, fileName);
  const backupDir = path.join(__dirname, 'backup', 'export');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destName = `${exportType}_${timestamp}.json`;
  const destPath = path.join(backupDir, destName);

  try {
    // 备份文件
    fs.copyFileSync(sourcePath, destPath);

    // 发送文件
    await bot.sendDocument(TELEGRAM_BOT_OWNER_ID, sourcePath, {
      caption: `${exportType}完成 - ${timestamp}`
    });

    // 清理旧备份
    const files = fs.readdirSync(backupDir)
      .map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);

    while (files.length > 10) {
      const oldFile = files.pop().name;
      fs.unlinkSync(path.join(backupDir, oldFile));
    }
  } catch (error) {
    console.error(`${exportType}失败:`, error);
  }
}

// 启动初始化
initialize().then(() => {
  console.log('机器人已启动');
});