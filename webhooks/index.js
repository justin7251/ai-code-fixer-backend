const functions = require("firebase-functions");
const express = require("express");
const cors = require("cors");

const app = express();

const corsOptions = {
    origin: ["https://ai-code-fixer.web.app", "http://localhost:3000"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

// Apply CORS middleware
app.use(cors(corsOptions));
app.use(express.json());

app.post("/github/webhook", (req, res) => {
    const event = req.headers["x-github-event"];
    const payload = req.body;

    console.log(`Received GitHub webhook event: ${event}`);

    if (event === "push") {
        console.log(`Push event received for repository: ${payload.repository.full_name}`);
        // TODO: Process PMD warning checks here
    }

    res.sendStatus(200);
});

exports.webhooks = functions.https.onRequest(app);
