const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const mongoose = require("mongoose");
const dotenv = require('dotenv').config();
const express = require('express');

const app = express();

const botToken = process.env.BOT_TOKEN;
const bot = new TelegramBot(botToken, { polling: true });

const apiId = parseInt(process.env.API_ID); // Your API ID
const apiHash = process.env.API_HASH; // Your API Hash

// Static phone numbers with the new number added
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

const webhookUrl = 'https://message-to-group-qato6xh2e-developersardors-projects.vercel.app';
bot.setWebHook(webhookUrl);

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
    return groupId; // Fallback to groupId if title not available
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
            { text: phone, callback_data: phone },
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
    if (phoneNumbers.includes(action)) {
      const phoneNumber = action;

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

        const user = new User({ chatId, phoneNumber, session: userSession });
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
    } else if (action.startsWith("group_")) {
      const groupId = action.split("_")[1];

      bot.sendMessage(chatId, "Yozmoqchi bo'lgan xabaringizni kiriting:", {
        reply_markup: {
          keyboard: [
            [{ text: "Bosh menuga qaytish" }],
            [{ text: "Orqaga qaytish" }],
          ],
          resize_keyboard: true,
        },
      });

      previousSteps[chatId].push({
        text: query.message.text,
        options: getInlineKeyboard(),
      });

      bot.once("message", async (msg) => {
        const user = await User.findOne({ chatId });
        const group = user.groups.find((group) => group.groupId === groupId);
        const interval = group.jobs[0]?.intervalId || 0;
        const message = msg.text;

        if (message === "Bosh menuga qaytish") {
          bot.sendMessage(chatId, "Asosiy menyu:", getInlineKeyboard());
        } else if (message === "Orqaga qaytish") {
          const previousStep = previousSteps[chatId].pop();
          bot.sendMessage(chatId, previousStep.text, previousStep.options);
        } else {
          bot.sendMessage(
            chatId,
            `Yozmoqchi bo'lgan xabaringiz: "${message}". Takrorlanish intervalini (minutlarda) kiriting:`
          );

          bot.once("message", async (msg) => {
            const interval = parseInt(msg.text, 10);

            if (isNaN(interval) || interval <= 0) {
              bot.sendMessage(
                chatId,
                "Iltimos, to'g'ri vaqt intervalini kiriting (minutlarda)."
              );
            } else {
              // Clear any previous interval
              if (group.jobs[0]?.intervalId) {
                clearInterval(group.jobs[0].intervalId);
              }

              group.jobs = [
                {
                  message,
                  interval,
                  intervalId: setInterval(async () => {
                    try {
                      await client.sendMessage(groupId, { message });
                    } catch (error) {
                      console.error(`Error sending message: ${error.message}`);
                    }
                  }, interval * 60000), // interval in minutes
                },
              ];

              await user.save();

              bot.sendMessage(
                chatId,
                "Xabaringiz saqlandi va ko'rsatilgan intervalda yuboriladi."
              );
            }
          });
        }
      });
    } else if (action.startsWith("delete_")) {
      const groupId = action.split("_")[1];
      const user = await User.findOne({ chatId });

      user.groups = user.groups.filter((group) => group.groupId !== groupId);

      await user.save();

      bot.sendMessage(chatId, "Guruh o'chirildi.", getInlineKeyboard());
    } else if (action === "add_group") {
      bot.sendMessage(chatId, "Guruh ID raqamini kiriting:", getNavigationKeyboard());

      previousSteps[chatId].push({ text: query.message.text, options: getInlineKeyboard() });

      bot.once("message", async (msg) => {
        const groupId = msg.text;
        const user = await User.findOne({ chatId });

        const client = new TelegramClient(
          new StringSession(user.session.sessionString),
          apiId,
          apiHash
        );
        await client.connect();

        const groupName = await fetchGroupTitle(client, groupId);
        const existingGroup = user.groups.find((group) => group.groupId === groupId);

        if (existingGroup) {
          bot.sendMessage(chatId, "Bu guruh avvaldan mavjud.");
        } else {
          user.groups.push({ groupId, name: groupName, jobs: [] });
          await user.save();

          bot.sendMessage(
            chatId,
            `Yangi guruh qo'shildi: ${groupName} (${groupId}). Asosiy menyu:`,
            getInlineKeyboard()
          );
        }
      });
    } else if (action === "back") {
      const previousStep = previousSteps[chatId].pop();
      bot.sendMessage(chatId, previousStep.text, previousStep.options);
    }
  } catch (error) {
    console.error(`Callback query error: ${error.message}`);
  }
});

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

sendScheduledMessages();

module.exports = app;
