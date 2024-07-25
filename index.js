const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const mongoose = require('mongoose');

const botToken = '7215312555:AAHDNFqUDmaAdTgpZ67B-ilgac7Mh4Jxzus';
const bot = new TelegramBot(botToken, { polling: true });

const apiId = 26958019;
const apiHash = 'e7d6928fbacac10dd0283b9aa3e79fcf';

// Static phone numbers with the new number added
const phoneNumbers = [
  "+998 94 981 11 29",
  "+998 94 373 69 72",
  "+998 94 633 26 51",
  "+998 94 511 11 29",
  "+998 94 202 61 57",
  "+998 97 007 37 47",
  "+998 97 400 24 04" // New phone number added here
];

mongoose.connect('mongodb://127.0.0.1:27017/message-bot', { useNewUrlParser: true, useUnifiedTopology: true });

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

const User = mongoose.model('User', userSchema);
const UserSession = mongoose.model('UserSession', userSessionSchema);

const getNavigationKeyboard = () => ({
  reply_markup: {
    keyboard: [
      [{ text: 'Orqaga qaytish' }],
      [{ text: 'Bosh menuga qaytish' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
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

async function sendScheduledMessages() {
  const users = await User.find();
  for (const user of users) {
    for (const group of user.groups) {
      for (const job of group.jobs) {
        if (job.intervalId) {
          clearInterval(job.intervalId);
        }

        const intervalId = setInterval(async () => {
          try {
            const client = new TelegramClient(new StringSession(user.session.sessionString), apiId, apiHash);
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

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const user = await User.findOne({ chatId });

    if (!user) {
      // User not found, show phone numbers
      const options = {
        reply_markup: {
          inline_keyboard: phoneNumbers.map(phone => [{ text: phone, callback_data: phone }]),
        },
      };
      bot.sendMessage(chatId, 'Telefon raqamni tanlang:', options);
    } else {
      // User found, show main menu
      const options = getInlineKeyboard();
      bot.sendMessage(chatId, "Asosiy menyu", options);
    }
  } catch (error) {
    bot.sendMessage(chatId, `Xatolik yuz berdi: ${error.message}`);
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  try {
    if (phoneNumbers.includes(action)) {
      const phoneNumber = action;

      let user = await User.findOne({ phoneNumber });
      if (!user) {
        let userSession = await UserSession.findOne({ chatId });
        if (!userSession) {
          const client = new TelegramClient(new StringSession(), apiId, apiHash);
          await client.start({
            phoneNumber: async () => phoneNumber,
            phoneCode: async () => {
              bot.sendMessage(chatId, "Tasdiqlash kodini kiriting (SMS orqali yoki Telegramdan oling):");
              return new Promise((resolve) => {
                bot.once("message", (msg) => {
                  if (msg.chat.id === chatId) {
                    resolve(msg.text);
                  }
                });
              });
            },
            password: async () => {
              bot.sendMessage(chatId, "Ikki faktorli autentifikatsiya parolini kiriting:");
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
          userSession = new UserSession({ chatId, sessionString: client.session.save() });
          await userSession.save();
        }

        user = new User({ chatId, phoneNumber, session: userSession });
        await user.save();

        bot.sendMessage(chatId, "Foydalanuvchi yaratildi. Asosiy menyu:", getInlineKeyboard());
      } else {
        bot.sendMessage(chatId, "Siz allaqachon ushbu telefon raqam bilan bog'langansiz.");
      }
    } else if (action === "existing_groups") {
      const user = await User.findOne({ chatId });
      const groups = user.groups.map(group => [
        { text: group.name, callback_data: `group_${group.groupId}` },
        { text: "O'chirish", callback_data: `delete_${group.groupId}` },
        { text: "To'xtatish", callback_data: `stop_${group.groupId}` },
      ]);

      const options = {
        reply_markup: {
          inline_keyboard: [
            ...groups,
            [{ text: "Orqaga qaytish", callback_data: "back" }]
          ],
        },
      };

      bot.sendMessage(chatId, "Mavjud guruhlar:", options);
    } else if (action === "add_group") {
      bot.sendMessage(chatId, "Yangi guruh ID sini kiriting:", getNavigationKeyboard());

      bot.once('message', async (msg) => {
        if (msg.chat.id === chatId) {
          const groupId = msg.text;

          const user = await User.findOne({ chatId });

          if (user) {
            // Yangi guruh qo'shamiz
            user.groups.push({ groupId, name: `Guruh ${user.groups.length + 1}`, jobs: [] });
            await user.save();

            bot.sendMessage(chatId, "Yangi guruh qo'shildi.", getNavigationKeyboard());
          } else {
            bot.sendMessage(chatId, "Foydalanuvchi topilmadi.");
          }
        }
      });
    } else if (action.startsWith('group_')) {
      const groupId = action.split('_')[1];
      const user = await User.findOne({ chatId });
      const group = user.groups.find(g => g.groupId === groupId);

      if (group) {
        bot.sendMessage(chatId, "Yuboriladigan xabarni kiriting:", getNavigationKeyboard());

        bot.once('message', async (msg) => {
          if (msg.chat.id === chatId) {
            const message = msg.text;

            bot.sendMessage(chatId, "Intervalni kiriting (daqiqalarda):", getNavigationKeyboard());

            bot.once('message', async (msg) => {
              if (msg.chat.id === chatId) {
                const interval = parseInt(msg.text, 10);

                // Yangi ish yaratish
                const job = {
                  message,
                  interval,
                  intervalId: null,
                };

                group.jobs.push(job);
                await user.save();

                bot.sendMessage(chatId, "Xabar yuborilishi boshlandi.", getNavigationKeyboard());

                const intervalId = setInterval(async () => {
                  try {
                    const client = new TelegramClient(new StringSession(user.session.sessionString), apiId, apiHash);
                    await client.connect();
                    await client.sendMessage(group.groupId, { message });
                  } catch (error) {
                    console.error(`Error sending message: ${error.message}`);
                  }
                }, interval * 60000); // interval in minutes

                job.intervalId = intervalId;
                await user.save();
              }
            });
          }
        });
      }
    } else if (action.startsWith('delete_')) {
      const groupId = action.split('_')[1];
      const user = await User.findOne({ chatId });

      if (user) {
        const groupIndex = user.groups.findIndex(g => g.groupId === groupId);
        if (groupIndex !== -1) {
          const group = user.groups[groupIndex];
          // Stop all jobs related to this group
          for (const job of group.jobs) {
            if (job.intervalId) {
              clearInterval(job.intervalId);
            }
          }
          user.groups.splice(groupIndex, 1);
          await user.save();

          bot.sendMessage(chatId, "Guruh o'chirildi.", getNavigationKeyboard());
        } else {
          bot.sendMessage(chatId, "Guruh topilmadi.");
        }
      } else {
        bot.sendMessage(chatId, "Foydalanuvchi topilmadi.");
      }
    } else if (action.startsWith('stop_')) {
      const groupId = action.split('_')[1];
      const user = await User.findOne({ chatId });

      if (user) {
        const group = user.groups.find(g => g.groupId === groupId);

        if (group) {
          // Har bir ishni to'xtatish
          for (const job of group.jobs) {
            if (job.intervalId) {
              clearInterval(job.intervalId);
              job.intervalId = null; // Interval ID ni null ga o'rnatamiz
            }
          }
          await user.save();

          bot.sendMessage(chatId, "Xabar yuborish to'xtatildi.", getNavigationKeyboard());
        } else {
          bot.sendMessage(chatId, "Guruh topilmadi.");
        }
      } else {
        bot.sendMessage(chatId, "Foydalanuvchi topilmadi.");
      }
    } else if (action === "back") {
      bot.sendMessage(chatId, "Asosiy menyu:", getInlineKeyboard());
    } else if (action === "main_menu") {
      bot.sendMessage(chatId, "Asosiy menyu:", getInlineKeyboard());
    }
  } catch (error) {
    bot.sendMessage(chatId, `Xatolik yuz berdi: ${error.message}`);
  }
});

// Start sending scheduled messages
sendScheduledMessages();
