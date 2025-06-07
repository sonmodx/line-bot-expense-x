const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");
const moment = require("moment");
require("dotenv").config();

// Firebase Admin SDK initialization
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID,
});

const db = admin.firestore();

// Line Bot configuration
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// Middleware
app.use("/webhook", line.middleware(config));
app.use(express.json());

// Expense categories
const CATEGORIES = [
  "🍔 Food",
  "🚗 Transport",
  "🛒 Shopping",
  "🎬 Entertainment",
  "💊 Health",
  "📚 Education",
  "🏠 Bills",
  "👕 Clothing",
  "🎁 Others",
];

// User states for conversation flow
const userStates = new Map();

// Helper function to create quick reply buttons
function createQuickReply(items) {
  return {
    type: "text",
    text: "Please select:",
    quickReply: {
      items: items.map((item) => ({
        type: "action",
        action: {
          type: "message",
          label: item,
          text: item,
        },
      })),
    },
  };
}

// Helper function to create flex message for expense summary
// Now accepts a chunk of expenses, a dynamic period title, and the total amount for the whole period.
function createExpenseSummary(expenseChunk, periodTitle, totalAmount) {
  const contents = expenseChunk.map((exp) => {
    const expenseDate = exp.date.toDate
      ? moment(exp.date.toDate()).format("DD/MM HH:mm")
      : moment(exp.createdAt).format("DD/MM HH:mm");

    return {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          contents: [
            {
              type: "text",
              text: exp.category.replace(/[^\w\s]/gi, ""),
              size: "sm",
              color: "#666666",
              flex: 2,
              weight: "bold",
            },
            {
              type: "text",
              text: `${Number(exp.amount.toFixed(2)).toLocaleString()}`,
              size: "sm",
              align: "end",
              weight: "bold",
              color: "#007bff",
            },
          ],
        },
        {
          type: "box",
          layout: "horizontal",
          contents: [
            {
              type: "text",
              text: exp.description || "No description",
              size: "xs",
              color: "#888888",
              flex: 2,
            },
            {
              type: "text",
              text: expenseDate,
              size: "xs",
              align: "end",
              color: "#aaaaaa",
            },
          ],
          margin: "xs",
        },
      ],
      margin: "md",
      paddingBottom: "sm",
    };
  });

  return {
    type: "flex",
    altText: `Expense Summary - Total: ${Number(
      totalAmount.toFixed(2)
    ).toLocaleString()} ฿`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: periodTitle, // e.g., "Month Expenses (Page 1/3)"
            weight: "bold",
            size: "lg",
            color: "#ffffff",
          },
        ],
        backgroundColor: "#007bff",
        paddingAll: "20px",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "text",
                text: "Total For Period:",
                weight: "bold",
                size: "md",
              },
              {
                type: "text",
                text: `${Number(totalAmount.toFixed(2)).toLocaleString()} ฿`,
                weight: "bold",
                size: "md",
                align: "end",
                color: "#007bff",
              },
            ],
            margin: "md",
          },
          {
            type: "separator",
            margin: "lg",
          },
          ...contents,
        ],
      },
    },
  };
}

// Add expense to Firestore
async function addExpense(userId, amount, category, description) {
  try {
    const expense = {
      userId,
      amount: parseFloat(amount),
      category,
      description: description || "No description",
      date: admin.firestore.Timestamp.now(),
      createdAt: moment().format("YYYY-MM-DD HH:mm:ss"),
    };

    await db.collection("expenses").add(expense);
    return true;
  } catch (error) {
    console.error("Error adding expense:", error);
    return false;
  }
}

// Get expenses from Firestore
async function getExpenses(userId, period = "today") {
  try {
    let startDate, endDate;
    const now = moment();

    switch (period) {
      case "week":
        startDate = now.startOf("week").toDate();
        endDate = now.endOf("week").toDate();
        break;
      case "month":
        startDate = now.startOf("month").toDate();
        endDate = now.endOf("month").toDate();
        break;
      default: // today
        startDate = now.startOf("day").toDate();
        endDate = now.endOf("day").toDate();
    }

    const snapshot = await db
      .collection("expenses")
      .where("userId", "==", userId)
      .where("date", ">=", admin.firestore.Timestamp.fromDate(startDate))
      .where("date", "<=", admin.firestore.Timestamp.fromDate(endDate))
      .orderBy("date", "desc")
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
  } catch (error) {
    console.error("Error getting expenses:", error);
    return [];
  }
}

// Handle different message types
async function handleMessage(event) {
  const { replyToken, source, message } = event;
  const userId = source.userId;
  const userMessage = message.text?.toLowerCase().trim();

  let replyMessage;

  const currentState = userStates.get(userId) || { step: "idle" };

  if (
    userMessage === "menu" ||
    userMessage === "help" ||
    userMessage === "/start"
  ) {
    replyMessage = {
      type: "text",
      text: '💰 Expense Manager Bot\n\nCommands:\n• "add" - Add new expense\n• "today" - Today\'s expenses\n• "week" - This week\'s expenses\n• "month" - This month\'s expenses\n• "menu" - Show this menu\n\nTo add expense, just type "add" and follow the steps!',
    };
    userStates.set(userId, { step: "idle" });
    return client.replyMessage(replyToken, replyMessage);
  }

  // Add expense flow
  if (userMessage === "add" || userMessage === "add expense") {
    replyMessage = {
      type: "text",
      text: "💵 Enter the expense amount (e.g., 15.50):",
    };
    userStates.set(userId, { step: "waiting_amount" });
  } else if (currentState.step === "waiting_amount") {
    const sanitizedMessage = userMessage.replace(/,/g, "");

    const amount = parseFloat(sanitizedMessage);
    if (isNaN(amount) || amount <= 0) {
      replyMessage = {
        type: "text",
        text: "❌ Please enter a valid amount (e.g., 15.50 or 10,000):",
      };
    } else {
      replyMessage = createQuickReply(CATEGORIES);
      userStates.set(userId, { step: "waiting_category", amount });
    }
  } else if (currentState.step === "waiting_category") {
    const userSelectCategory = message.text;
    if (CATEGORIES.includes(userSelectCategory)) {
      replyMessage = {
        type: "text",
        text: '📝 Enter a description for this expense (or type "skip"):',
      };
      userStates.set(userId, {
        step: "waiting_description",
        amount: currentState.amount,
        category: userSelectCategory,
      });
    } else {
      replyMessage = createQuickReply(CATEGORIES);
    }
  } else if (currentState.step === "waiting_description") {
    const description = userMessage === "skip" ? "" : userMessage;
    const success = await addExpense(
      userId,
      currentState.amount,
      currentState.category,
      description
    );

    if (success) {
      replyMessage = {
        type: "text",
        text: `✅ Expense added successfully!\n\n💰 Amount:  ${Number(
          currentState.amount
        ).toLocaleString()} ฿\n📁 Category: ${
          currentState.category
        }\n📝 Description: ${
          description || "No description"
        }\n\nType "add" to add another expense or "today" to see today's summary.`,
      };
    } else {
      replyMessage = {
        type: "text",
        text: "❌ Failed to add expense. Please try again.",
      };
    }
    userStates.set(userId, { step: "idle" });
  }

  // View expenses with message splitting
  else if (["today", "week", "month"].includes(userMessage)) {
    const expenses = await getExpenses(userId, userMessage);

    if (expenses.length === 0) {
      const periodText =
        userMessage === "today" ? "today" : `this ${userMessage}`;
      replyMessage = {
        type: "text",
        text: `📊 No expenses recorded for ${periodText}.\n\nType "add" to add your first expense!`,
      };
      return client.replyMessage(replyToken, replyMessage);
    }

    // Logic to split messages
    const CHUNK_SIZE = 5;
    const totalAmount = expenses.reduce((sum, exp) => sum + exp.amount, 0);
    const periodTitleBase =
      userMessage.charAt(0).toUpperCase() + userMessage.slice(1);
    const messagesToSend = [];

    for (let i = 0; i < expenses.length; i += CHUNK_SIZE) {
      const chunk = expenses.slice(i, i + CHUNK_SIZE);
      const totalPages = Math.ceil(expenses.length / CHUNK_SIZE);
      const currentPage = i / CHUNK_SIZE + 1;
      const pageTitle =
        totalPages > 1
          ? `${periodTitleBase} Expenses (Page ${currentPage}/${totalPages})`
          : `${periodTitleBase} Expenses`;

      messagesToSend.push(createExpenseSummary(chunk, pageTitle, totalAmount));
    }

    // Use replyMessage for the first chunk, then pushMessage for the rest
    await client.replyMessage(replyToken, messagesToSend[0]);

    if (messagesToSend.length > 1) {
      // Send remaining chunks as new messages
      await client.pushMessage(userId, messagesToSend.slice(1));
    }
    return; // Important: Exit after manually handling reply/push
  }

  // Default response for unrecognized commands or during conversation flow
  else {
    replyMessage = {
      type: "text",
      text: '🤔 I didn\'t understand that command.\n\nType "menu" to see available commands or "add" to add an expense.',
    };
  }

  // Final reply for flows that fall through
  return client.replyMessage(replyToken, replyMessage);
}

// Webhook endpoint
app.post("/webhook", (req, res) => {
  Promise.all(req.body.events.map(handleMessage))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Error handling webhook:", err);
      res.status(500).end();
    });
});

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "Line Expense Bot is running!",
    timestamp: new Date().toISOString(),
  });
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🤖 Line Expense Bot is running on port ${port}`);
  console.log(`📊 Ready to track expenses!`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down Line Expense Bot...");
  process.exit(0);
});

module.exports = app;
