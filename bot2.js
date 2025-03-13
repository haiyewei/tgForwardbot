require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// 初始化配置
const {
  TELEGRAM_BOT_TOKEN,
  GROUP_ID,
  USER_INFO_TOPIC_NAME
} = process.env;


// 初始化机器人
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// 优化存储结构：双向映射
const userTopicMap = new Map();       // userID -> topicInfo
const topicUserMap = new Map();       // topicID -> userID
let USER_INFO_TOPIC_ID;

// 初始化函数
async function initialize() {
  try {
    console.log('正在初始化机器人...');

    // 验证群组信息
    const chat = await bot.getChat(GROUP_ID);
    if (chat.type !== 'supergroup') throw new Error('需要超级群组');
    if (!chat.is_forum) throw new Error('群组未开启论坛功能');

    // 处理用户信息话题
    let isNewTopic = false;
    const topics = await getForumTopics();
    let userInfoTopic = topics.find(t => t.name === USER_INFO_TOPIC_NAME);

    if (!userInfoTopic) {
      console.log('正在创建用户信息话题...');
      const newTopic = await bot.createForumTopic(
        GROUP_ID,
        USER_INFO_TOPIC_NAME,
        { icon_color: 0x6FB9F0 }
      );
      USER_INFO_TOPIC_ID = newTopic.message_thread_id;
      isNewTopic = true;

      // 等待话题创建完成
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      USER_INFO_TOPIC_ID = userInfoTopic.message_thread_id;

      // 加载历史映射数据（新增）
      await loadHistoryMappings();
    }

    // 发送启动通知
    const statusMessage = isNewTopic ?
      '🤖 机器人初始化启动成功！' :
      '✅ 机器人启动成功，检测到已有配置';

    await bot.sendMessage(GROUP_ID, statusMessage, {
      message_thread_id: USER_INFO_TOPIC_ID
    });

    console.log(statusMessage);

  } catch (error) {
    console.error('初始化失败:', error.message);
    process.exit(1);
  }
}

function loadUserMappings() {
  const filePath = path.join(__dirname, 'user_info.txt');
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  for (let i = 1; i < lines.length; i) {
    const parts = lines[i].split('---');
    if (parts.length >= 2) {
      const [topicId, ...rest] = parts;
      const userId = rest.pop();
      const username = rest.join('---') || '';

      // 添加重复用户ID检查
      if (!userTopicMap.has(userId)) {
        userTopicMap.set(userId, { topicId, username });
        topicUserMap.set(topicId, userId);
      }
    }
  }
}


// 修改原getForumTopics函数
async function getForumTopics() {
  try {
    // 更新为正确的API调用方式
    const chat = await bot.getChat(GROUP_ID);
    if (!chat.is_forum) throw new Error('群组未开启论坛功能');

    // 使用官方推荐方式获取话题
    const topics = await bot.getForumTopics(GROUP_ID);
    return topics || [];
  } catch (error) {
    console.error('获取话题列表失败:', error.message);
    return [];
  }
}

// 创建新话题
async function createForumTopic(user) {
  try {
    // 先检查内存中是否存在用户映射
    if (userTopicMap.has(user.id.toString())) {
      return userTopicMap.get(user.id.toString()).topicId;
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

    // 添加文件级重复检查
    const fileContent = fs.readFileSync('user_info.txt', 'utf-8');
    if (!fileContent.includes(`---${user.id}`)) {
      fs.appendFileSync(path.join(__dirname, 'user_info.txt'), `\n${userLine}`, 'utf-8');
    }

    // 更新映射
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

// 处理私聊消息
bot.on('message', async msg => {
  if (msg.chat.type !== 'private') return;

  const user = msg.from;
  const userKey = user.id.toString();

  try {
    let topicId = userTopicMap.get(userKey)?.topicId;

    if (!topicId) {
      topicId = await createForumTopic(user);
      if (!topicId) return;

      userTopicMap.set(userKey, {
        topicId,
        username: user.username || ''
      });
    }

    // 转发消息到群组话题
    await bot.forwardMessage(GROUP_ID, msg.chat.id, msg.message_id, {
      message_thread_id: topicId
    });
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
      console.log(`已转发消息到用户 ${userId}`);
    }
  } catch (error) {
    console.error('处理群组回复失败:', error.message);
  }
});

// 启动初始化
initialize().then(() => {
  console.log('机器人已启动');
});
