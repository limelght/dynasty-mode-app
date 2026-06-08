const {onDocumentCreated, onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const twilio = require("twilio");
const webpush = require("web-push");

admin.initializeApp();

const db = admin.firestore();

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

function twilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
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

exports.health = onRequest((req, res) => {
  res.json({
    ok: true,
    project: process.env.GCLOUD_PROJECT || null,
    channels: {
      email: !!smtpTransport(),
      sms: !!twilioClient(),
      push: configureWebPush()
    },
    webPushPublicKey: process.env.WEB_PUSH_PUBLIC_KEY || null
  });
});

exports.processNotificationJob = onDocumentCreated("notificationJobs/{jobId}", async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;
  const job = snapshot.data();
  const updates = {
    status: "processing",
    processedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await snapshot.ref.set(updates, {merge: true});

  const results = [];

  try {
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

    if (job.channels?.sms && job.sms?.to) {
      const client = twilioClient();
      if (client && process.env.TWILIO_FROM_NUMBER) {
        await client.messages.create({
          to: job.sms.to,
          from: process.env.TWILIO_FROM_NUMBER,
          body: job.sms.body || job.message || ""
        });
        results.push({channel: "sms", status: "sent"});
      } else {
        results.push({channel: "sms", status: "skipped", reason: "twilio_not_configured"});
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
