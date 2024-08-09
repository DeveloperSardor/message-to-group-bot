const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const mongoose = require("mongoose");
const express = require('express');

const app = express();

const botToken = process.env.BOT_TOKEN; // Your Telegram bot token
const bot = new TelegramBot(botToken, { polling: true });

const apiId = process.env.API_ID; // Your API ID
const apiHash = process.env.API_HASH; // Your API Hash



const phoneNumbers = [
  "+998 94 981 11 29",
  "+998 94 373 69 72",
  "+998 94 633 26 51",
  "+998 94 511 11 29",
  "+998 94 202 61 57",
  "+998 97 007 37 47",
  "+998 97 400 24 04", // New phone number added here
];

mongoose.connect(process.env.DB_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const userSessionSchema = new mongoose.Schema({
  chatId: String,
  sessionString: String,
});

const jobSchema = new mongoose.Schema({
  message: String,
  interval: Number,
  intervalId: Number,
});

const groupSchema = new mongoose.Schema({
  groupId: String,
  name: String,
  jobs: [jobSchema],
});

const userSchema = new mongoose.Schema({
  chatId: String,
  phoneNumber: String,
  groups: [groupSchema],
  session: userSessionSchema,
});

const User = mongoose.model("User", userSchema);
const UserSession = mongoose.model("UserSession", userSessionSchema);

const previousSteps = {};

const getNavigationKeyboard = () => ({
  reply_markup: {
    keyboard: [[{ text: "Orqaga qaytish" }], [{ text: "Bosh menuga qaytish" }]],
    resize_keyboard: true,
  },
});

const getInlineKeyboard = () => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: "Mavjud guruhlar", callback_data: "existing_groups" }],
      [{ text: "Yangi guruh qo'shish", callback_data: "add_group" }],
      [{ text: "Telefon raqamni almashtirish", callback_data: "switch_phone" }],
    ],
  },
});

async function fetchGroupTitle(client, groupId) {
  try {
    const result = await client.invoke({
      _: "getChat",
      chat_id: groupId,
    });
    return result.title || result.username || groupId;
  } catch (error) {
    console.error(`Error fetching group title: ${error.message}`);
    return groupId;
  }
}

async function sendScheduledMessages() {
  const users = await User.find();
  for (const user of users) {
    for (const group of user.groups) {
      for (const job of group.jobs) {
        if (job.interval > 0) {
          if (job.intervalId) {
            clearInterval(job.intervalId);
          }

          const intervalId = setInterval(async () => {
            try {
              const client = new TelegramClient(
                new StringSession(user.session.sessionString),
                apiId,
                apiHash
              );
              await client.connect();
              await client.sendMessage(group.groupId, { message: job.message });
            } catch (error) {
              console.error(`Error sending message: ${error.message}`);
            }
          }, job.interval * 60000); // interval in minutes

          job.intervalId = intervalId;
          await user.save();
        }
      }
    }
  }
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const user = await User.findOne({ chatId });

    if (!user) {
      // User not found, show phone numbers
      const options = {
        reply_markup: {
          inline_keyboard: phoneNumbers.map((phone) => [
            { text: phone, callback_data: `phoneCode_${phone}` },
          ]),
        },
      };
      bot.sendMessage(chatId, "Telefon raqamni tanlang:", options);
    } else {
      // User found, show main menu
      const options = getInlineKeyboard();
      bot.sendMessage(chatId, "Asosiy menyu", options);
    }
  } catch (error) {
    bot.sendMessage(chatId, `Xatolik yuz berdi: ${error.message}`);
  }
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  if (!previousSteps[chatId]) {
    previousSteps[chatId] = [];
  }

  try {
    if (action.startsWith('phoneCode_')) {
      const phoneNumber = action.split('_')[1];
      let user = await User.findOne({ phoneNumber });

      if (!user) {
        let userSession = await UserSession.findOne({ chatId });

        if (!userSession) {
          const client = new TelegramClient(
            new StringSession(),
            apiId,
            apiHash
          );

          await client.start({
            phoneNumber: async () => phoneNumber,
            phoneCode: async () => {
              bot.sendMessage(
                chatId,
                "Tasdiqlash kodini kiriting (SMS orqali yoki Telegramdan oling):"
              );
              return new Promise((resolve) => {
                bot.once("message", (msg) => {
                  if (msg.chat.id === chatId) {
                    resolve(msg.text);
                  }
                });
              });
            },
            password: async () => {
              bot.sendMessage(
                chatId,
                "Ikki faktorli autentifikatsiya parolini kiriting:"
              );
              return new Promise((resolve) => {
                bot.once("message", (msg) => {
                  if (msg.chat.id === chatId) {
                    resolve(msg.text);
                  }
                });
              });
            },
            onError: (err) => {
              bot.sendMessage(chatId, `Xatolik yuz berdi: ${err.message}`);
            },
          });

          userSession = new UserSession({
            chatId,
            sessionString: client.session.save(),
          });
          await userSession.save();
        }

        user = new User({ chatId, phoneNumber, session: userSession });
        await user.save();

        bot.sendMessage(
          chatId,
          "Foydalanuvchi yaratildi. Asosiy menyu:",
          getInlineKeyboard()
        );
      } else {
        bot.sendMessage(
          chatId,
          "Siz allaqachon ushbu telefon raqam bilan bog'langansiz."
        );
      }
    } else if (action === "existing_groups") {
      const user = await User.findOne({ chatId });
      const client = new TelegramClient(
        new StringSession(user.session.sessionString),
        apiId,
        apiHash
      );
      await client.connect();

      const groups = await Promise.all(
        user.groups.map(async (group) => {
          const groupName = await fetchGroupTitle(client, group.groupId);
          return [
            { text: `${groupName} (${group.groupId})`, callback_data: `group_${group.groupId}` },
            { text: "O'chirish", callback_data: `delete_${group.groupId}` },
            { text: "To'xtatish", callback_data: `stop_${group.groupId}` },
          ];
        })
      );

      const options = {
        reply_markup: {
          inline_keyboard: [
            ...groups,
            [{ text: "Orqaga qaytish", callback_data: "back" }],
          ],
        },
      };

      previousSteps[chatId].push({ text: query.message.text, options: getInlineKeyboard() });
      bot.sendMessage(chatId, "Mavjud guruhlar:", options);
    } else if (action === "add_group") {
      previousSteps[chatId].push({ text: query.message.text, options: getInlineKeyboard() });

      bot.sendMessage(
        chatId,
        "Yangi guruh ID sini kiriting:",
        getNavigationKeyboard()
      );

      bot.once("message", async (msg) => {
        if (msg.chat.id === chatId) {
          const groupId = msg.text;

          const user = await User.findOne({ chatId });

          if (user) {
            const client = new TelegramClient(
              new StringSession(user.session.sessionString),
              apiId,
              apiHash
            );
            await client.connect();

            const groupName = await fetchGroupTitle(client, groupId);

            user.groups.push({
              groupId,
              name: groupName,
              jobs: [],
            });
            await user.save();

            bot.sendMessage(
              chatId,
              `Yangi guruh qo'shildi: ${groupName} (${groupId})`,
              getInlineKeyboard()
            );
          } else {
            bot.sendMessage(chatId, "Avval telefon raqamingizni tasdiqlang.");
          }
        }
      });
    } else if (action.startsWith("group_")) {
      const groupId = action.split("_")[1];
      bot.sendMessage(
        chatId,
        `Guruh uchun nima qilishni xohlaysiz?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Xabar yuborish", callback_data: `send_message_${groupId}` }],
              [{ text: "To'xtatish", callback_data: `stop_${groupId}` }],
              [{ text: "Orqaga qaytish", callback_data: "back" }],
            ],
          },
        }
      );
    } else if (action.startsWith("send_message_")) {
      const groupId = action.split("_")[2];

      bot.sendMessage(
        chatId,
        "Xabarni kiriting:",
        getNavigationKeyboard()
      );

      bot.once("message", async (msg) => {
        if (msg.chat.id === chatId) {
          const message = msg.text;

          bot.sendMessage(
            chatId,
            "Xabar intervalini kiriting (daqiqalarda):",
            getNavigationKeyboard()
          );

          bot.once("message", async (msg) => {
            if (msg.chat.id === chatId) {
              const interval = parseInt(msg.text, 10);

              const user = await User.findOne({ chatId });
              const group = user.groups.find((g) => g.groupId === groupId);

              if (group) {
                group.jobs.push({ message, interval });
                await user.save();

                bot.sendMessage(chatId, `Xabar interval bilan yuboriladi: ${interval} daqiqa`);
                sendScheduledMessages();
              } else {
                bot.sendMessage(chatId, "Guruh topilmadi.");
              }
            }
          });
        }
      });
    } else if (action.startsWith("stop_")) {
      const groupId = action.split("_")[1];

      const user = await User.findOne({ chatId });
      const group = user.groups.find((g) => g.groupId === groupId);

      if (group) {
        for (const job of group.jobs) {
          if (job.intervalId) {
            clearInterval(job.intervalId);
            job.intervalId = null;
          }
        }
        await user.save();
        bot.sendMessage(chatId, "Xabar yuborilishi to'xtatildi.");
      } else {
        bot.sendMessage(chatId, "Guruh topilmadi.");
      }
    } else if (action === "switch_phone") {
      previousSteps[chatId].push({ text: query.message.text, options: getInlineKeyboard() });

      const options = {
        reply_markup: {
          inline_keyboard: phoneNumbers.map((phone) => [
            { text: phone, callback_data: `phoneCode_${phone}` },
          ]),
        },
      };
      bot.sendMessage(chatId, "Telefon raqamni tanlang:", options);
    } else if (action === "back") {
      const previousStep = previousSteps[chatId].pop();

      if (previousStep) {
        bot.sendMessage(chatId, previousStep.text, previousStep.options);
      } else {
        bot.sendMessage(chatId, "Boshqa orqaga qaytish imkoniyati mavjud emas.");
      }
    } else if (action === "main_menu") {
      bot.sendMessage(chatId, "Asosiy menyu:", getInlineKeyboard());
    }
  } catch (error) {
    bot.sendMessage(chatId, `Xatolik yuz berdi: ${error.message}`);
  }
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
