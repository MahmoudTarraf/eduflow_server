const User = require('../models/User');
const Message = require('../models/Message');
const { sendEmail } = require('./sendEmail');

const notifyAdminsAboutUploadIssue = async ({ uploaderId, uploaderName, issueType, context }) => {
  try {
    const admins = await User.find({
      role: 'admin',
      isDeleted: { $ne: true },
      status: { $ne: 'deleted' }
    }).select('email name notifications');

    const safeName = uploaderName || 'Instructor';
    const subject = issueType === 'quota'
      ? '[Admin Alert] Video upload quota exceeded'
      : '[Admin Alert] Video hosting authentication required';

    const notificationMessage = issueType === 'quota'
      ? `Video uploads are failing due to quota limits. Triggered by ${safeName}.`
      : `Video uploads are failing due to platform authentication. Triggered by ${safeName}.`;

    const messageContent = issueType === 'quota'
      ? `A video upload failed because the daily upload quota appears to be exhausted.\n\nTriggered by: ${safeName}\nContext: ${context || 'video upload'}\nAction: Wait for quota to reset / reduce uploads.`
      : `A video upload failed because the platform video hosting account needs admin attention.\n\nTriggered by: ${safeName}\nContext: ${context || 'video upload'}\nAction: Re-authenticate the platform video hosting account.`;

    for (const admin of admins) {
      try {
        admin.notifications.push({
          message: notificationMessage,
          type: 'warning',
          read: false
        });
        await admin.save();
      } catch (_) {}

      try {
        if (admin.email) {
          await sendEmail({
            email: admin.email,
            subject,
            message: messageContent
          });
        }
      } catch (emailError) {
        console.error('Admin email notification failed (upload issue):', emailError);
      }

      try {
        if (uploaderId) {
          await Message.create({
            sender: uploaderId,
            recipient: admin._id,
            conversationType: 'admin',
            priority: 'high',
            subject,
            content: messageContent
          });
        }
      } catch (_) {}
    }
  } catch (notifyError) {
    console.error('Failed to notify admins about upload issue:', notifyError);
  }
};

module.exports = { notifyAdminsAboutUploadIssue };
