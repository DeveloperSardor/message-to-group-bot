const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

// Replace with your own values
const token = "YOUR_TELEGRAM_BOT_TOKEN";
const apiId = "YOUR_API_ID";
const apiHash = "YOUR_API_HASH";
const phoneNumbers = [
  "+998 94 981 11 29",
  "+998 94 373 69 72",
  "+998 94 633 26 51",
  "+998 94 511 11 29",
  "+998 94 202 61 57",
  "+998 97 007 37 47",
];

const bot = new TelegramBot(token, { polling: true });

// MongoDB connection
mongoose.connect("mongodb://localhost:27017/telegrambot", {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Schema definitions
const userSchema = new mongoose.Schema({
  chatId: Number,
  phoneNumber: String,
  session: { type: mongoose.Schema.Types.ObjectId, ref: "UserSession" },
  groups: [
    {
      groupId: String,
      name: String,
      jobs: [
        {
          message: String,
          interval: Number,
          intervalId: Number,
        },
      ],
    },
  ],
});

const userSessionSchema = new mongoose.Schema({
  chatId: Number,
  sessionString: String,
});

const User = mongoose.model("User", userSchema);
const UserSession = mongoose.model("UserSession", userSessionSchema);

const previousSteps = {};

// Helper function to get the main menu inline keyboard
function getInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Mavjud guruhlar", callback_data: "existing_groups" }],
        [{ text: "Yangi guruh qo'shish", callback_data: "add_group" }],
        [{ text: "Telefon raqamni o'zgartirish", callback_data: "switch_phone" }],
      ],
    },
  };
}

// Helper function to fetch group title
async function fetchGroupTitle(client, groupId) {
  try {
    const chat = await client.getChat(groupId);
    return chat.title;
  } catch (error) {
    return "Noma'lum guruh";
  }
}

// Start command handler
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

// Callback query handler
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
        const client = new TelegramClient(new StringSession(), apiId, apiHash);
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

      bot.removeListener("message"); // Remove previous listeners
      bot.once("message", async (msg) => {
        const user = await User.findOne({ chatId });
        const group = user.groups.find((group) => group.groupId === groupId);
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

          bot.removeListener("message"); // Remove previous listeners
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
      bot.sendMessage(chatId, "Guruh ID raqamini kiriting:");

      previousSteps[chatId].push({
        text: query.message.text,
        options: getInlineKeyboard(),
      });

      bot.removeListener("message"); // Remove previous listeners
      bot.once("message", async (msg) => {
        const groupId = msg.text;

        const user = await User.findOne({ chatId });

        if (user.groups.some((group) => group.groupId === groupId)) {
          bot.sendMessage(
            chatId,
            "Bu guruh allaqachon mavjud.",
            getInlineKeyboard()
          );
        } else {
          const client = new TelegramClient(
            new StringSession(user.session.sessionString),
            apiId,
            apiHash
          );
          await client.connect();

          const groupName = await fetchGroupTitle(client, groupId);

          user.groups.push({ groupId, name: groupName, jobs: [] });
          await user.save();

          bot.sendMessage(
            chatId,
            `Yangi guruh qo'shildi: ${groupName}`,
            getInlineKeyboard()
          );
        }
      });
    } else if (action === "switch_phone") {
      // Handle phone number switching
      const options = {
        reply_markup: {
          inline_keyboard: phoneNumbers.map((phone) => [
            { text: phone, callback_data: phone },
          ]),
        },
      };

      previousSteps[chatId].push({
        text: query.message.text,
        options: getInlineKeyboard(),
      });

      bot.sendMessage(chatId, "Telefon raqamni tanlang:", options);
    } else if (action === "back") {
      const previousStep = previousSteps[chatId].pop();

      if (previousStep) {
        bot.sendMessage(chatId, previousStep.text, previousStep.options);
      } else {
        bot.sendMessage(chatId, "Asosiy menyu", getInlineKeyboard());
      }
    }
  } catch (error) {
    bot.sendMessage(chatId, `Xatolik yuz berdi: ${error.message}`);
  }
});
