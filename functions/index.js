const {onDocumentCreated, onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const webpush = require("web-push");

admin.initializeApp();

const db = admin.firestore();
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 20;
const ADMIN_CHALLENGE_TTL_MS = 1000 * 60 * 10;

function smtpTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {user, pass}
  });
}

function smtpReady() {
  return !!smtpTransport();
}

function configureWebPush() {
  if (!process.env.WEB_PUSH_PUBLIC_KEY || !process.env.WEB_PUSH_PRIVATE_KEY || !process.env.WEB_PUSH_SUBJECT) return false;
  webpush.setVapidDetails(
      process.env.WEB_PUSH_SUBJECT,
      process.env.WEB_PUSH_PUBLIC_KEY,
      process.env.WEB_PUSH_PRIVATE_KEY,
  );
  return true;
}

function telegramReady() {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

function whatsappReady() {
  return !!process.env.WHATSAPP_ACCESS_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID;
}

function adminEmails() {
  return String(process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
}

function isAdminEmail(email) {
  if (!email) return false;
  return adminEmails().includes(String(email).trim().toLowerCase());
}

function providerDiagnostics() {
  return {
    email: {
      ready: smtpReady(),
      missing: ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"].filter((key) => !process.env[key]),
    },
    push: {
      ready: configureWebPush(),
      missing: ["WEB_PUSH_SUBJECT", "WEB_PUSH_PUBLIC_KEY", "WEB_PUSH_PRIVATE_KEY"].filter((key) => !process.env[key]),
    },
    discord: {
      ready: true,
      missing: [],
      note: "User-provided webhooks are used per profile.",
    },
    telegram: {
      ready: telegramReady(),
      missing: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET"].filter((key) => !process.env[key]),
      botUsername: process.env.TELEGRAM_BOT_USERNAME || null,
    },
    whatsapp: {
      ready: whatsappReady(),
      missing: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"].filter((key) => !process.env[key]),
      note: "Meta business credentials are required for production sending.",
    },
  };
}

async function postJson(url, payload, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
  return response;
}

async function verifyFirebaseUserFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new Error("missing_bearer_token");
  }
  return admin.auth().verifyIdToken(match[1]);
}

async function verifyAdminSession(req, decodedToken) {
  const sessionToken = req.headers["x-admin-session"];
  if (!sessionToken) throw new Error("missing_admin_session");
  const sessionSnap = await db.collection("adminSessions").doc(String(sessionToken)).get();
  if (!sessionSnap.exists) throw new Error("invalid_admin_session");
  const session = sessionSnap.data() || {};
  const expiresAt = session.expiresAt?.toMillis ? session.expiresAt.toMillis() : 0;
  if (session.uid !== decodedToken.uid || expiresAt < Date.now()) {
    throw new Error("expired_admin_session");
  }
  return session;
}

async function sendNotificationThroughChannels(job) {
  const results = [];

  if (job.channels?.email && job.email?.to) {
    const transporter = smtpTransport();
    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: job.email.to,
        subject: job.email.subject || "Dynasty Mode Update",
        text: job.email.text || job.message || ""
      });
      results.push({channel: "email", status: "sent"});
    } else {
      results.push({channel: "email", status: "skipped", reason: "smtp_not_configured"});
    }
  }

  if (job.channels?.discord && Array.isArray(job.discord?.webhooks) && job.discord.webhooks.length) {
    await Promise.all(job.discord.webhooks.map((webhookUrl) => postJson(webhookUrl, {
      content: job.discord?.content || job.message || "",
    })));
    results.push({channel: "discord", status: "sent"});
  }

  if (job.channels?.telegram && Array.isArray(job.telegram?.chatIds) && job.telegram.chatIds.length) {
    if (telegramReady()) {
      await Promise.all(job.telegram.chatIds.map((chatId) => postJson(
          `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            chat_id: chatId,
            text: job.telegram?.text || job.message || "",
          },
      )));
      results.push({channel: "telegram", status: "sent"});
    } else {
      results.push({channel: "telegram", status: "skipped", reason: "telegram_not_configured"});
    }
  }

  if (job.channels?.push && Array.isArray(job.pushSubscriptions) && job.pushSubscriptions.length) {
    const pushReady = configureWebPush();
    if (pushReady) {
      await Promise.all(job.pushSubscriptions.map((subscription) => webpush.sendNotification(subscription, JSON.stringify({
        title: job.push?.title || "Dynasty Mode",
        body: job.push?.body || job.message || ""
      }))));
      results.push({channel: "push", status: "sent"});
    } else {
      results.push({channel: "push", status: "skipped", reason: "web_push_not_configured"});
    }
  }

  if (job.channels?.whatsapp && Array.isArray(job.whatsapp?.to) && job.whatsapp.to.length) {
    if (whatsappReady()) {
      await Promise.all(job.whatsapp.to.map((phoneNumber) => postJson(
          `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to: phoneNumber,
            type: "text",
            text: {
              body: job.whatsapp?.body || job.message || "",
            },
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            },
          },
      )));
      results.push({channel: "whatsapp", status: "sent"});
    } else {
      results.push({channel: "whatsapp", status: "skipped", reason: "whatsapp_not_configured"});
    }
  }

  return results;
}

exports.health = onRequest((req, res) => {
  const diagnostics = providerDiagnostics();
  res.json({
    ok: true,
    project: process.env.GCLOUD_PROJECT || null,
    adminConfigured: adminEmails().length > 0,
    channels: {
      email: diagnostics.email.ready,
      push: diagnostics.push.ready,
      discord: true,
      telegram: diagnostics.telegram.ready,
      whatsapp: diagnostics.whatsapp.ready
    },
    webPushPublicKey: process.env.WEB_PUSH_PUBLIC_KEY || null,
    telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || null,
    diagnostics,
  });
});

exports.startAdminAccessChallenge = onRequest(async (req, res) => {
  try {
    const decodedToken = await verifyFirebaseUserFromRequest(req);
    if (!isAdminEmail(decodedToken.email)) {
      res.status(403).json({ok: false, reason: "not_admin"});
      return;
    }
    const transporter = smtpTransport();
    if (!transporter) {
      res.status(400).json({ok: false, reason: "smtp_not_configured"});
      return;
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const challengeId = `admin-${decodedToken.uid}`;
    await db.collection("adminChallenges").doc(challengeId).set({
      uid: decodedToken.uid,
      email: decodedToken.email,
      code,
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + ADMIN_CHALLENGE_TTL_MS),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: decodedToken.email,
      subject: "Dynasty Mode backoffice verification code",
      text: `Your Dynasty Mode backoffice code is ${code}. It expires in 10 minutes.`,
    });

    res.json({ok: true, sent: true});
  } catch (error) {
    res.status(500).json({ok: false, error: error.message || "admin_challenge_failed"});
  }
});

exports.verifyAdminAccessChallenge = onRequest(async (req, res) => {
  try {
    const decodedToken = await verifyFirebaseUserFromRequest(req);
    if (!isAdminEmail(decodedToken.email)) {
      res.status(403).json({ok: false, reason: "not_admin"});
      return;
    }
    const code = String(req.body?.code || "").trim();
    if (!code) {
      res.status(400).json({ok: false, reason: "missing_code"});
      return;
    }

    const challengeId = `admin-${decodedToken.uid}`;
    const challengeSnap = await db.collection("adminChallenges").doc(challengeId).get();
    if (!challengeSnap.exists) {
      res.status(400).json({ok: false, reason: "challenge_not_found"});
      return;
    }
    const challenge = challengeSnap.data() || {};
    const expiresAt = challenge.expiresAt?.toMillis ? challenge.expiresAt.toMillis() : 0;
    if (expiresAt < Date.now()) {
      res.status(400).json({ok: false, reason: "challenge_expired"});
      return;
    }
    if (String(challenge.code) !== code) {
      res.status(400).json({ok: false, reason: "invalid_code"});
      return;
    }

    const sessionToken = `admin-session-${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
    await db.collection("adminSessions").doc(sessionToken).set({
      uid: decodedToken.uid,
      email: decodedToken.email,
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + ADMIN_SESSION_TTL_MS),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection("adminChallenges").doc(challengeId).delete();

    res.json({ok: true, sessionToken, expiresInMinutes: 20});
  } catch (error) {
    res.status(500).json({ok: false, error: error.message || "admin_verify_failed"});
  }
});

exports.sendAdminTestNotification = onRequest(async (req, res) => {
  try {
    const decodedToken = await verifyFirebaseUserFromRequest(req);
    if (!isAdminEmail(decodedToken.email)) {
      res.status(403).json({ok: false, reason: "not_admin"});
      return;
    }
    await verifyAdminSession(req, decodedToken);

    const requestedChannel = String(req.body?.channel || "").trim();
    const message = String(req.body?.message || "Dynasty Mode backoffice test notification").trim();
    if (!requestedChannel) {
      res.status(400).json({ok: false, reason: "missing_channel"});
      return;
    }

    const userSnap = await db.collection("users").doc(decodedToken.uid).get();
    const profile = userSnap.exists ? userSnap.data() || {} : {};
    const channels = {
      email: requestedChannel === "email",
      push: requestedChannel === "push",
      discord: requestedChannel === "discord",
      telegram: requestedChannel === "telegram",
      whatsapp: requestedChannel === "whatsapp",
    };

    const job = {
      message,
      channels,
      email: {
        to: profile.notificationEmail ? [profile.notificationEmail] : [],
        subject: "Dynasty Mode backoffice test",
        text: message,
      },
      discord: {
        webhooks: profile.discordWebhookUrl ? [profile.discordWebhookUrl] : [],
        content: `**Dynasty Mode Test**\n${message}`,
      },
      telegram: {
        chatIds: profile.telegramChatId ? [profile.telegramChatId] : [],
        text: `Dynasty Mode Test\n${message}`,
      },
      whatsapp: {
        to: profile.whatsappNumber ? [profile.whatsappNumber] : [],
        body: `Dynasty Mode Test\n${message}`,
      },
      push: {
        title: "Dynasty Mode Test",
        body: message,
      },
      pushSubscriptions: Array.isArray(profile.pushSubscriptions) ? profile.pushSubscriptions : [],
    };

    const results = await sendNotificationThroughChannels(job);
    res.json({ok: true, results});
  } catch (error) {
    res.status(500).json({ok: false, error: error.message || "admin_test_failed"});
  }
});

exports.verifyEmailTransport = onRequest(async (req, res) => {
  const transporter = smtpTransport();
  if (!transporter) {
    res.status(400).json({
      ok: false,
      reason: "smtp_not_configured",
      diagnostics: providerDiagnostics().email,
    });
    return;
  }

  try {
    await transporter.verify();
    res.json({ok: true, verified: true});
  } catch (error) {
    res.status(500).json({
      ok: false,
      verified: false,
      error: error.message || "verify_failed",
    });
  }
});

exports.setupTelegramWebhook = onRequest(async (req, res) => {
  if (!telegramReady() || !process.env.TELEGRAM_BOT_USERNAME || !process.env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(400).json({
      ok: false,
      reason: "telegram_not_fully_configured",
      diagnostics: providerDiagnostics().telegram,
    });
    return;
  }

  const webhookUrl = `https://us-central1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/telegramWebhook?secret=${encodeURIComponent(process.env.TELEGRAM_WEBHOOK_SECRET)}`;
  const response = await postJson(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    url: webhookUrl,
    allowed_updates: ["message"],
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
  });

  const payload = await response.json();
  res.json({
    ok: true,
    webhookUrl,
    telegramResponse: payload,
  });
});

exports.telegramWebhook = onRequest(async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || null;
  if (secret && req.query.secret !== secret) {
    res.status(403).json({ok: false, error: "forbidden"});
    return;
  }

  const message = req.body?.message;
  const text = message?.text || "";
  const chatId = message?.chat?.id ? String(message.chat.id) : null;
  const match = text.match(/^\/start(?:@\w+)?\s+dynasty_([A-Za-z0-9_-]+)$/);

  if (!chatId || !match) {
    res.json({ok: true, ignored: true});
    return;
  }

  const linkCode = match[1];
  const userSnap = await db.collection("users").where("telegramLinkCode", "==", linkCode).limit(1).get();
  if (userSnap.empty) {
    res.json({ok: true, linked: false, reason: "code_not_found"});
    return;
  }

  const userDoc = userSnap.docs[0];
  const userData = userDoc.data() || {};
  const currentPrefs = userData.notificationPrefs || {};
  await userDoc.ref.set({
    telegramChatId: chatId,
    telegramLinkedAt: admin.firestore.FieldValue.serverTimestamp(),
    telegramLinkCode: admin.firestore.FieldValue.delete(),
    notificationPrefs: {
      ...currentPrefs,
      telegram: true
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, {merge: true});

  if (telegramReady()) {
    await postJson(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: "Dynasty Mode connected. You can now receive league updates in Telegram."
    });
  }

  res.json({ok: true, linked: true});
});

exports.processNotificationJob = onDocumentCreated("notificationJobs/{jobId}", async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;
  const job = snapshot.data();
  let results = [];
  const updates = {
    status: "processing",
    processedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await snapshot.ref.set(updates, {merge: true});

  try {
    results = await sendNotificationThroughChannels(job);

    await snapshot.ref.set({
      status: "complete",
      deliveryResults: results,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    }, {merge: true});
  } catch (error) {
    logger.error("Notification job failed", error);
    await snapshot.ref.set({
      status: "error",
      errorMessage: error.message || "Unknown error",
      deliveryResults: results,
      failedAt: admin.firestore.FieldValue.serverTimestamp()
    }, {merge: true});
  }
});

exports.trackLeagueStatusChange = onDocumentUpdated("leagues/{leagueId}", async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!before || !after) return;

  const beforeStatus = before.status || "active";
  const afterStatus = after.status || "active";
  if (beforeStatus === afterStatus) return;

  const leagueId = event.params.leagueId;
  const changedAt = admin.firestore.FieldValue.serverTimestamp();
  const changedByUID = after.statusChangedByUID || after.commissionerUID || after.commissionerId || null;
  const patch = {
    lastRecordedStatus: afterStatus,
    statusChangedAt: changedAt,
  };

  if (changedByUID) patch.statusChangedByUID = changedByUID;

  if (afterStatus === "archived") {
    patch.archivedAt = changedAt;
    if (changedByUID) patch.archivedByUID = changedByUID;
  } else if (afterStatus === "ended") {
    patch.endedAt = changedAt;
    if (changedByUID) patch.endedByUID = changedByUID;
  } else if (afterStatus === "active" && (beforeStatus === "archived" || beforeStatus === "ended")) {
    patch.reinstatedAt = changedAt;
    patch.lastInactiveStatus = beforeStatus;
    if (changedByUID) patch.reinstatedByUID = changedByUID;
  }

  await event.data.after.ref.set(patch, {merge: true});
  await db.collection("leagues").doc(leagueId).collection("statusHistory").add({
    fromStatus: beforeStatus,
    toStatus: afterStatus,
    changedByUID,
    changedAt,
  });
});
