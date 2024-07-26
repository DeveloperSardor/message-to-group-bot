const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const mongoose = require("mongoose");

const botToken = "7215312555:AAHDNFqUDmaAdTgpZ67B-ilgac7Mh4Jxzus";
const bot = new TelegramBot(botToken, { polling: true });

const apiId = 26958019;
const apiHash = "e7d6928fbacac10dd0283b9aa3e79fcf";


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

mongoose.connect("mongodb://127.0.0.1:27017/message-bot", {
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

const getNavigationKeyboard = () => ({
  reply_markup: {
    keyboard: [[{ text: "Orqaga qaytish" }], [{ text: "Bosh menuga qaytish" }]],
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

  try {
    if (phoneNumbers.includes(action)) {
      const phoneNumber = action;

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

      bot.sendMessage(chatId, "Mavjud guruhlar:", options);
    } else if (action === "add_group") {
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

            // Yangi guruh qo'shamiz
            user.groups.push({
              groupId,
              name: groupName,
              jobs: [],
            });
            await user.save();

            bot.sendMessage(
              chatId,
              `Yangi guruh qo'shildi: ${groupName} (${groupId})`,
              getNavigationKeyboard()
            );
          } else {
            bot.sendMessage(chatId, "Foydalanuvchi topilmadi.");
          }
        }
      });
    } else if (action.startsWith("group_")) {
      const groupId = action.split("_")[1];
      const user = await User.findOne({ chatId });
      const group = user.groups.find((g) => g.groupId === groupId);

      if (group) {
        bot.sendMessage(
          chatId,
          "Yuboriladigan xabarni kiriting:",
          getNavigationKeyboard()
        );

        bot.once("message", async (msg) => {
          if (msg.chat.id === chatId) {
            const message = msg.text;

            bot.sendMessage(
              chatId,
              "Intervalni kiriting (daqiqalarda):",
              getNavigationKeyboard()
            );

            bot.once("message", async (msg) => {
              if (msg.chat.id === chatId) {
                const interval = parseInt(msg.text, 10);

                if (!isNaN(interval) && interval > 0) {
                  // Add a new job to the group
                  group.jobs.push({
                    message,
                    interval,
                    intervalId: null,
                  });

                  await user.save();
                  sendScheduledMessages(); // Recalculate scheduling

                  bot.sendMessage(
                    chatId,
                    `Xabar yuborish sozlandi: "${message}" har ${interval} daqiqada.`,
                    getNavigationKeyboard()
                  );
                } else {
                  bot.sendMessage(
                    chatId,
                    "Interval noto'g'ri. Iltimos, raqamni kiriting.",
                    getNavigationKeyboard()
                  );
                }
              }
            });
          }
        });
      } else {
        bot.sendMessage(chatId, "Guruh topilmadi.");
      }
    } else if (action.startsWith("stop_")) {
      const groupId = action.split("_")[1];
      const user = await User.findOne({ chatId });
      const group = user.groups.find((g) => g.groupId === groupId);

      if (group) {
        // Clear all jobs and their intervals
        group.jobs.forEach((job) => {
          if (job.intervalId) {
            clearInterval(job.intervalId);
          }
        });

        // Remove jobs from the group
        group.jobs = [];
        await user.save();

        bot.sendMessage(
          chatId,
          `Guruhdagi barcha xabarlar to'xtatildi va o'chirildi.`,
          getNavigationKeyboard()
        );
      } else {
        bot.sendMessage(chatId, "Guruh topilmadi.");
      }
    } else if (action.startsWith("delete_")) {
      const groupId = action.split("_")[1];
      const user = await User.findOne({ chatId });
      const groupIndex = user.groups.findIndex((g) => g.groupId === groupId);

      if (groupIndex !== -1) {
        // Clear all jobs and their intervals
        user.groups[groupIndex].jobs.forEach((job) => {
          if (job.intervalId) {
            clearInterval(job.intervalId);
          }
        });

        // Remove the group from the user's groups
        user.groups.splice(groupIndex, 1);
        await user.save();

        bot.sendMessage(
          chatId,
          `Guruh o'chirildi.`,
          getNavigationKeyboard()
        );
      } else {
        bot.sendMessage(chatId, "Guruh topilmadi.");
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





































// const TelegramBot = require("node-telegram-bot-api");
// const { TelegramClient } = require("telegram");
// const { StringSession } = require("telegram/sessions");
// const mongoose = require("mongoose");

// const botToken = "7215312555:AAHDNFqUDmaAdTgpZ67B-ilgac7Mh4Jxzus";
// const bot = new TelegramBot(botToken, { polling: true });

// const apiId = 26958019;
// const apiHash = "e7d6928fbacac10dd0283b9aa3e79fcf";


// // Static phone numbers with the new number added
// const phoneNumbers = [
//   "+998 94 981 11 29",
//   "+998 94 373 69 72",
//   "+998 94 633 26 51",
//   "+998 94 511 11 29",
//   "+998 94 202 61 57",
//   "+998 97 007 37 47",
//   "+998 97 400 24 04", // New phone number added here
// ];

// mongoose.connect("mongodb://127.0.0.1:27017/message-bot", {
//   useNewUrlParser: true,
//   useUnifiedTopology: true,
// });

// const userSchema = new mongoose.Schema({
//   chatId: String,
//   phoneNumber: String,
//   state: String, // New field to track user state
//   session: {
//     sessionString: String,
//   },
//   groups: [
//     {
//       groupId: String,
//       name: String,
//       jobs: [
//         {
//           message: String,
//           interval: Number,
//           intervalId: Number,
//         },
//       ],
//     },
//   ],
// });

// const User = mongoose.model("User", userSchema);

// const getNavigationKeyboard = () => ({
//   reply_markup: {
//     keyboard: [
//       [{ text: "Orqaga qaytish" }],
//       [{ text: "Bosh menuga qaytish" }]
//     ],
//     resize_keyboard: true,
//     one_time_keyboard: true,
//   },
// });

// const getInlineKeyboard = () => ({
//   reply_markup: {
//     inline_keyboard: [
//       [{ text: "Mavjud guruhlar", callback_data: "existing_groups" }],
//       [{ text: "Yangi guruh qo'shish", callback_data: "add_group" }],
//     ],
//   },
// });

// async function fetchGroupTitle(client, groupId) {
//   try {
//     const result = await client.invoke({
//       _: "getChat",
//       chat_id: groupId,
//     });
//     return result.title || result.username || groupId;
//   } catch (error) {
//     console.error(`Error fetching group title: ${error.message}`);
//     return groupId;
//   }
// }

// async function sendScheduledMessages() {
//   const users = await User.find();
//   for (const user of users) {
//     for (const group of user.groups) {
//       for (const job of group.jobs) {
//         if (job.interval > 0) {
//           if (job.intervalId) {
//             clearInterval(job.intervalId);
//           }

//           const intervalId = setInterval(async () => {
//             try {
//               const client = new TelegramClient(
//                 new StringSession(user.session.sessionString),
//                 apiId,
//                 apiHash
//               );
//               await client.connect();
//               await client.sendMessage(group.groupId, { message: job.message });
//             } catch (error) {
//               console.error(`Error sending message: ${error.message}`);
//             }
//           }, job.interval * 60000); // interval in minutes

//           job.intervalId = intervalId;
//           await user.save();
//         }
//       }
//     }
//   }
// }

// bot.onText(/\/start/, async (msg) => {
//   const chatId = msg.chat.id;

//   try {
//     const user = await User.findOne({ chatId });

//     if (!user) {
//       // User not found, show phone numbers
//       const options = {
//         reply_markup: {
//           inline_keyboard: phoneNumbers.map((phone) => [
//             { text: phone, callback_data: phone },
//           ]),
//         },
//       };
//       bot.sendMessage(chatId, "Telefon raqamni tanlang:", options);
//     } else {
//       // User found, show main menu
//       user.state = "main_menu";
//       await user.save();
//       const options = getInlineKeyboard();
//       bot.sendMessage(chatId, "Asosiy menyu", options);
//     }
//   } catch (error) {
//     bot.sendMessage(chatId, `Xatolik yuz berdi: ${error.message}`);
//   }
// });

// bot.on("callback_query", async (query) => {
//   const chatId = query.message.chat.id;
//   const action = query.data;

//   try {
//     let user = await User.findOne({ chatId });

//     if (!user) {
//       bot.sendMessage(chatId, "Foydalanuvchi topilmadi.");
//       return;
//     }

//     if (phoneNumbers.includes(action)) {
//       const phoneNumber = action;

//       let existingUser = await User.findOne({ phoneNumber });
//       if (!existingUser) {
//         let userSession = await User.findOne({ chatId });
//         if (!userSession) {
//           const client = new TelegramClient(
//             new StringSession(),
//             apiId,
//             apiHash
//           );
//           await client.start({
//             phoneNumber: async () => phoneNumber,
//             phoneCode: async () => {
//               bot.sendMessage(
//                 chatId,
//                 "Tasdiqlash kodini kiriting (SMS orqali yoki Telegramdan oling):"
//               );
//               return new Promise((resolve) => {
//                 bot.once("message", (msg) => {
//                   if (msg.chat.id === chatId) {
//                     resolve(msg.text);
//                   }
//                 });
//               });
//             },
//             password: async () => {
//               bot.sendMessage(
//                 chatId,
//                 "Ikki faktorli autentifikatsiya parolini kiriting:"
//               );
//               return new Promise((resolve) => {
//                 bot.once("message", (msg) => {
//                   if (msg.chat.id === chatId) {
//                     resolve(msg.text);
//                   }
//                 });
//               });
//             },
//             onError: (err) => {
//               bot.sendMessage(chatId, `Xatolik yuz berdi: ${err.message}`);
//             },
//           });
//           userSession = new User({
//             chatId,
//             phoneNumber,
//             session: { sessionString: client.session.save() },
//           });
//           await userSession.save();
//         }

//         user = new User({
//           chatId,
//           phoneNumber,
//           session: userSession.session,
//           state: "main_menu",
//         });
//         await user.save();

//         bot.sendMessage(
//           chatId,
//           "Foydalanuvchi yaratildi. Asosiy menyu:",
//           getInlineKeyboard()
//         );
//       } else {
//         bot.sendMessage(
//           chatId,
//           "Siz allaqachon ushbu telefon raqam bilan bog'langansiz."
//         );
//       }
//     } else if (action === "existing_groups") {
//       user.state = "viewing_groups";
//       await user.save();

//       const client = new TelegramClient(
//         new StringSession(user.session.sessionString),
//         apiId,
//         apiHash
//       );
//       await client.connect();

//       const groups = await Promise.all(
//         user.groups.map(async (group) => {
//           const groupName = await fetchGroupTitle(client, group.groupId);
//           return [
//             { text: `${groupName} (${group.groupId})`, callback_data: `group_${group.groupId}` },
//             { text: "O'chirish", callback_data: `delete_${group.groupId}` },
//             { text: "To'xtatish", callback_data: `stop_${group.groupId}` },
//           ];
//         })
//       );

//       const options = {
//         reply_markup: {
//           inline_keyboard: [
//             ...groups,
//             [{ text: "Orqaga qaytish", callback_data: "back" }],
//           ],
//         },
//       };

//       bot.sendMessage(chatId, "Mavjud guruhlar:", options);
//     } else if (action === "add_group") {
//       user.state = "adding_group";
//       await user.save();

//       bot.sendMessage(
//         chatId,
//         "Yangi guruh ID sini kiriting:",
//         getNavigationKeyboard()
//       );
//     } else if (action.startsWith("group_")) {
//       user.state = "sending_message";
//       await user.save();

//       const groupId = action.split("_")[1];
//       const group = user.groups.find((g) => g.groupId === groupId);

//       if (group) {
//         bot.sendMessage(
//           chatId,
//           "Yuboriladigan xabarni kiriting:",
//           getNavigationKeyboard()
//         );

//         bot.once("message", async (msg) => {
//           if (msg.chat.id === chatId) {
//             const message = msg.text;

//             bot.sendMessage(
//               chatId,
//               "Intervalni kiriting (daqiqalarda):",
//               getNavigationKeyboard()
//             );

//             bot.once("message", async (msg) => {
//               if (msg.chat.id === chatId) {
//                 const interval = parseInt(msg.text, 10);

//                 if (!isNaN(interval) && interval > 0) {
//                   // Yangi ishni guruhga qo'shish
//                   group.jobs.push({
//                     message,
//                     interval,
//                     intervalId: null,
//                   });

//                   await user.save();
//                   sendScheduledMessages(); // Recalculate scheduling

//                   bot.sendMessage(
//                     chatId,
//                     `Xabar yuborish sozlandi: "${message}" har ${interval} daqiqada.`,
//                     getNavigationKeyboard()
//                   );
//                 } else {
//                   bot.sendMessage(
//                     chatId,
//                     "Interval noto'g'ri. Iltimos, raqamni kiriting.",
//                     getNavigationKeyboard()
//                   );
//                 }
//               }
//             });
//           }
//         });
//       } else {
//         bot.sendMessage(chatId, "Guruh topilmadi.");
//       }
//     } else if (action.startsWith("stop_")) {
//       const groupId = action.split("_")[1];
//       const user = await User.findOne({ chatId });
//       const group = user.groups.find((g) => g.groupId === groupId);

//       if (group) {
//         // Barcha ishlarni va intervalarni tozalash
//         group.jobs.forEach((job) => {
//           if (job.intervalId) {
//             clearInterval(job.intervalId);
//           }
//         });

//         // Ishlarni guruhdan olib tashlash
//         group.jobs = [];
//         await user.save();

//         bot.sendMessage(
//           chatId,
//           `Guruhdagi barcha xabarlar to'xtatildi va o'chirildi.`,
//           getNavigationKeyboard()
//         );
//       } else {
//         bot.sendMessage(chatId, "Guruh topilmadi.");
//       }
//     } else if (action.startsWith("delete_")) {
//       const groupId = action.split("_")[1];
//       const user = await User.findOne({ chatId });
//       const groupIndex = user.groups.findIndex((g) => g.groupId === groupId);

//       if (groupIndex !== -1) {
//         // Barcha ishlarni va intervalarni tozalash
//         user.groups[groupIndex].jobs.forEach((job) => {
//           if (job.intervalId) {
//             clearInterval(job.intervalId);
//           }
//         });

//         // Guruhni foydalanuvchidan olib tashlash
//         user.groups.splice(groupIndex, 1);
//         await user.save();

//         bot.sendMessage(
//           chatId,
//           `Guruh o'chirildi.`,
//           getNavigationKeyboard()
//         );
//       } else {
//         bot.sendMessage(chatId, "Guruh topilmadi.");
//       }
//     } else if (action === "back") {
//       if (user.state === "viewing_groups") {
//         user.state = "main_menu";
//         await user.save();
//         bot.sendMessage(chatId, "Asosiy menyu:", getInlineKeyboard());
//       } else if (user.state === "sending_message") {
//         user.state = "viewing_groups";
//         await user.save();
//         const client = new TelegramClient(
//           new StringSession(user.session.sessionString),
//           apiId,
//           apiHash
//         );
//         await client.connect();

//         const groups = await Promise.all(
//           user.groups.map(async (group) => {
//             const groupName = await fetchGroupTitle(client, group.groupId);
//             return [
//               { text: `${groupName} (${group.groupId})`, callback_data: `group_${group.groupId}` },
//               { text: "O'chirish", callback_data: `delete_${group.groupId}` },
//               { text: "To'xtatish", callback_data: `stop_${group.groupId}` },
//             ];
//           })
//         );

//         const options = {
//           reply_markup: {
//             inline_keyboard: [
//               ...groups,
//               [{ text: "Orqaga qaytish", callback_data: "back" }],
//             ],
//           },
//         };

//         bot.sendMessage(chatId, "Mavjud guruhlar:", options);
//       } else {
//         bot.sendMessage(chatId, "Asosiy menyu:", getInlineKeyboard());
//       }
//     } else if (action === "main_menu") {
//       user.state = "main_menu";
//       await user.save();
//       bot.sendMessage(chatId, "Asosiy menyu:", getInlineKeyboard());
//     }
//   } catch (error) {
//     bot.sendMessage(chatId, `Xatolik yuz berdi: ${error.message}`);
//   }
// });
