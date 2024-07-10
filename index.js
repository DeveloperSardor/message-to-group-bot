const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const TelegramBot = require("node-telegram-bot-api");
const schedule = require("node-schedule");

const botToken = "7215312555:AAHDNFqUDmaAdTgpZ67B-ilgac7Mh4Jxzus";
const bot = new TelegramBot(botToken, { polling: true });

const apiId = 26736826;
const apiHash = "7ccfa1525aa7b97bcc7d915f0093c6a2";

// Static phone numbers
const phoneNumbers = ["+998 94 981 11 29", "+998 99 373 69 72",  "+998901234570", "+998901234571", "+998901234572", "+998901234573", "+998901234574"];

// Dictionary to store user sessions and groups
const userSessions = {};
const userGroups = {};

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const options = {
    reply_markup: {
      inline_keyboard: phoneNumbers.map((phone) => [{ text: phone, callback_data: phone }])
    }
  };
  bot.sendMessage(chatId, "Telefon raqamingizni tanlang:", options);
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const phoneNumber = query.data;

  try {
    // Check if the user has an existing session
    let userSession = userSessions[chatId];
    if (!userSession) {
      // Create a new session for the user
      const client = new TelegramClient(new StringSession(), apiId, apiHash, {
        connectionRetries: 5,
      });
      await client.start({
        phoneNumber: async () => phoneNumber,
        phoneCode: async () => {
          bot.sendMessage(chatId, "Tasdiqlash kodini kiriting (SMS orqali yoki Telegramdan oling):");
          return new Promise((resolve) => {
            bot.once("message", (msg) => {
              resolve(msg.text);
            });
          });
        },
        password: async () => {
          bot.sendMessage(chatId, "Ikki faktorli autentifikatsiya parolini kiriting:");
          return new Promise((resolve) => {
            bot.once("message", (msg) => {
              resolve(msg.text);
            });
          });
        },
        onError: (err) => {
          bot.sendMessage(chatId, `Xatolik yuz berdi: ${err.message}`);
        },
      });
      userSession = client.session.save();
      userSessions[chatId] = userSession;
      userGroups[chatId] = [];
    }

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Oldingi guruhlar", callback_data: "existing_groups" }],
          [{ text: "Yangi guruh qo'shish", callback_data: "add_group" }]
        ]
      }
    };
    bot.sendMessage(chatId, "Guruhlarni boshqarish uchun tanlang:", options);
  } catch (error) {
    console.log("Kirish muvaffaqiyatsiz:", error);
    bot.sendMessage(chatId, "Kirish muvaffaqiyatsiz. Iltimos, qaytadan urinib ko'ring.");
  }
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "existing_groups") {
    const groups = userGroups[chatId] || [];
    if (groups.length === 0) {
      bot.sendMessage(chatId, "Guruh hali yo'q, yangi guruh qo'shing.");
      return;
    }
    const client = new TelegramClient(new StringSession(userSessions[chatId]), apiId, apiHash, { connectionRetries: 5 });
    await client.start();
    const groupButtons = await Promise.all(groups.map(async (group) => {
      const entity = await client.getEntity(group);
      return [
        { text: `${entity.title} (${group})`, callback_data: `group_${group}` },
        { text: "O'chirish", callback_data: `delete_${group}` }
      ];
    }));
    const options = {
      reply_markup: {
        inline_keyboard: groupButtons
      }
    };
    bot.sendMessage(chatId, "Guruhni tanlang:", options);
  } else if (data === "add_group") {
    bot.sendMessage(chatId, "Guruh/kanal ID sini yuboring:");
    bot.once("message", async (msg) => {
      const groupId = msg.text.trim();
      try {
        const client = new TelegramClient(new StringSession(userSessions[chatId]), apiId, apiHash, { connectionRetries: 5 });
        await client.start();
        const entity = await client.getEntity(groupId);
        if (entity) {
          userGroups[chatId].push(groupId);
          bot.sendMessage(chatId, `Guruh qo'shildi: ${entity.title} (${groupId})`);
        } else {
          bot.sendMessage(chatId, "Xato guruh/kanal ID. Iltimos, qaytadan kiriting.");
        }
      } catch (error) {
        bot.sendMessage(chatId, "Xato guruh/kanal ID. Iltimos, qaytadan kiriting.");
      }
    });
  } else if (data.startsWith("group_")) {
    const groupId = data.split("_")[1];
    bot.sendMessage(chatId, "Xabarni kiriting:", { reply_markup: { remove_keyboard: true } });
    bot.once("message", (msg) => {
      const messageText = msg.text;
      bot.sendMessage(chatId, "Xabar yuborilishi oralig'ini daqiqalarda kiriting:");
      bot.once("message", (msg) => {
        const intervalMinutes = parseInt(msg.text);
        if (isNaN(intervalMinutes) || intervalMinutes <= 0) {
          bot.sendMessage(chatId, "Iltimos, raqam kiriting.");
          return;
        }

        // Schedule the message sending job
        const job = schedule.scheduleJob(`${chatId}:${groupId}:message`, `*/${intervalMinutes} * * * *`, async () => {
          try {
            const client = new TelegramClient(new StringSession(userSessions[chatId]), apiId, apiHash, { connectionRetries: 5 });
            await client.start();
            await client.sendMessage(groupId, { message: messageText });
            console.log(`Xabar ${groupId} ga yuborildi ${new Date().toLocaleTimeString()} da`);
          } catch (error) {
            console.log("Xatolik yuz berdi xabar yuborishda:", error);
          }
        });

        bot.sendMessage(chatId, `Xabar har ${intervalMinutes} daqiqada ${groupId} ga yuboriladi.`);
      });
    });
  } else if (data.startsWith("delete_")) {
    const groupId = data.split("_")[1];
    const groupIndex = userGroups[chatId].indexOf(groupId);
    if (groupIndex > -1) {
      userGroups[chatId].splice(groupIndex, 1);
      bot.sendMessage(chatId, `Guruh o'chirildi: ${groupId}`);
    } else {
      bot.sendMessage(chatId, "Guruh topilmadi.");
    }
  }
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  const jobs = Object.keys(schedule.scheduledJobs).filter((job) => job.startsWith(`${chatId}:`));
  jobs.forEach((job) => schedule.scheduledJobs[job].cancel());
  bot.sendMessage(chatId, "Xabarni avtomatik yuborish to'xtatildi.");
});

bot.onText(/\/reset/, (msg) => {
  const chatId = msg.chat.id;
  const jobs = Object.keys(schedule.scheduledJobs).filter((job) => job.startsWith(`${chatId}:`));
  jobs.forEach((job) => schedule.scheduledJobs[job].cancel());
  delete userSessions[chatId];
  delete userGroups[chatId];
  bot.sendMessage(chatId, "Yangi xabarni qayta yozish uchun /start ni bosing.");
});

process.on("SIGINT", () => {
  console.log("Ilova to'xtatilmoqda...");
  Object.values(schedule.scheduledJobs).forEach((job) => job.cancel());
  process.exit(0);
});
