const { sendEmail } = require('./sendEmail');

// Email notification functions for major events

// Send email when instructor account is approved
const sendInstructorApprovalEmail = async (instructorEmail, instructorName) => {
  try {
    await sendEmail({
      email: instructorEmail,
      subject: 'Your Instructor Account Has Been Approved!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4F46E5;">Congratulations, ${instructorName}!</h2>
          <p>Your instructor account has been approved. You can now start creating courses and teaching students.</p>
          <p>Login to your dashboard to get started:</p>
          <a href="${process.env.CLIENT_URL}/login" style="display: inline-block; background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 10px;">
            Login to Dashboard
          </a>
          <p style="margin-top: 20px; color: #666;">Best regards,<br>The ${process.env.FROM_NAME} Team</p>
        </div>
      `
    });
  } catch (error) {
    console.error('Error sending instructor approval email:', error);
  }
};

// Send email when new course is created
const sendNewCourseEmail = async (studentEmail, studentName, courseName, instructorName) => {
  try {
    await sendEmail({
      email: studentEmail,
      subject: `New Course Available: ${courseName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4F46E5;">New Course Available!</h2>
          <p>Hi ${studentName},</p>
          <p>A new course has been added to our platform:</p>
          <div style="background-color: #F3F4F6; padding: 15px; border-radius: 5px; margin: 15px 0;">
            <h3 style="margin-top: 0; color: #1F2937;">${courseName}</h3>
            <p style="margin-bottom: 0; color: #666;">Instructor: ${instructorName}</p>
          </div>
          <a href="${process.env.CLIENT_URL}/courses" style="display: inline-block; background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 10px;">
            Browse Courses
          </a>
          <p style="margin-top: 20px; color: #666;">Best regards,<br>The ${process.env.FROM_NAME} Team</p>
        </div>
      `
    });
  } catch (error) {
    console.error('Error sending new course email:', error);
  }
};

// Send email when new content is added to enrolled course
const sendNewContentEmail = async (studentEmail, studentName, contentTitle, courseName) => {
  try {
    await sendEmail({
      email: studentEmail,
      subject: `New Content Added: ${courseName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4F46E5;">New Content Available!</h2>
          <p>Hi ${studentName},</p>
          <p>New content has been added to your course:</p>
          <div style="background-color: #F3F4F6; padding: 15px; border-radius: 5px; margin: 15px 0;">
            <h3 style="margin-top: 0; color: #1F2937;">${contentTitle}</h3>
            <p style="margin-bottom: 0; color: #666;">Course: ${courseName}</p>
          </div>
          <a href="${process.env.CLIENT_URL}/student/courses" style="display: inline-block; background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 10px;">
            View Content
          </a>
          <p style="margin-top: 20px; color: #666;">Best regards,<br>The ${process.env.FROM_NAME} Team</p>
        </div>
      `
    });
  } catch (error) {
    console.error('Error sending new content email:', error);
  }
};

// Send email when assignment is graded
const sendAssignmentGradedEmail = async (studentEmail, studentName, assignmentTitle, grade, courseName) => {
  try {
    const gradeColor = grade >= 70 ? '#10B981' : '#EF4444';
    await sendEmail({
      email: studentEmail,
      subject: `Assignment Graded: ${assignmentTitle}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4F46E5;">Assignment Graded</h2>
          <p>Hi ${studentName},</p>
          <p>Your assignment has been graded:</p>
          <div style="background-color: #F3F4F6; padding: 15px; border-radius: 5px; margin: 15px 0;">
            <h3 style="margin-top: 0; color: #1F2937;">${assignmentTitle}</h3>
            <p style="color: #666;">Course: ${courseName}</p>
            <p style="margin-bottom: 0;">Grade: <strong style="color: ${gradeColor}; font-size: 24px;">${grade}%</strong></p>
          </div>
          <a href="${process.env.CLIENT_URL}/student/courses" style="display: inline-block; background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 10px;">
            View Details
          </a>
          <p style="margin-top: 20px; color: #666;">Best regards,<br>The ${process.env.FROM_NAME} Team</p>
        </div>
      `
    });
  } catch (error) {
    console.error('Error sending assignment graded email:', error);
  }
};

// Send email when certificate is received
const sendCertificateReceivedEmail = async (studentEmail, studentName, courseName, certificateUrl) => {
  try {
    await sendEmail({
      email: studentEmail,
      subject: `🎉 Certificate Issued: ${courseName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4F46E5;">🎉 Congratulations!</h2>
          <p>Hi ${studentName},</p>
          <p>You have successfully completed <strong>${courseName}</strong> and earned your certificate!</p>
          <div style="background-color: #F3F4F6; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: center;">
            <img src="https://img.icons8.com/color/96/000000/certificate.png" alt="Certificate" style="width: 80px; height: 80px;"/>
            <p style="font-size: 18px; font-weight: bold; color: #1F2937; margin-top: 10px;">Certificate of Completion</p>
          </div>
          <a href="${process.env.CLIENT_URL}/student/certificates" style="display: inline-block; background-color: #10B981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 10px;">
            View Certificate
          </a>
          <p style="margin-top: 20px; color: #666;">Congratulations on your achievement!<br>The ${process.env.FROM_NAME} Team</p>
        </div>
      `
    });
  } catch (error) {
    console.error('Error sending certificate email:', error);
  }
};

// Send email when message is received
const sendMessageNotificationEmail = async (recipientEmail, recipientName, senderName, senderRole, subject, content) => {
  try {
    const roleColors = {
      admin: '#EF4444',
      instructor: '#3B82F6',
      student: '#10B981'
    };
    const roleColor = roleColors[senderRole] || '#6B7280';
    
    // Escape HTML and preserve line breaks
    const formattedContent = content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    
    await sendEmail({
      email: recipientEmail,
      subject: `New Message from ${senderName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4F46E5;">New Message Received</h2>
          <p>Hi ${recipientName},</p>
          <p>You have received a new message from <strong style="color: ${roleColor};">${senderName}</strong> (${senderRole}):</p>
          <div style="background-color: #F3F4F6; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid ${roleColor};">
            <h3 style="margin-top: 0; color: #1F2937;">${subject}</h3>
            <p style="margin-bottom: 0; color: #666; white-space: pre-wrap;">${formattedContent}</p>
          </div>
          <a href="${process.env.CLIENT_URL}/messages" style="display: inline-block; background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 10px;">
            View in Messages
          </a>
          <p style="margin-top: 20px; color: #666;">Best regards,<br>The ${process.env.FROM_NAME} Team</p>
        </div>
      `
    });
  } catch (error) {
    console.error('Error sending message notification email:', error);
  }
};

// Send email when discount is approved for instructor
const sendNewDiscountEmail = async (instructorEmail, instructorName, courseName, percentage, days) => {
  try {
    await sendEmail({
      email: instructorEmail,
      subject: `Discount Approved: ${courseName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10B981;">🎉 Discount Approved!</h2>
          <p>Hi ${instructorName},</p>
          <p>Great news! Your discount request has been approved:</p>
          <div style="background-color: #F3F4F6; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #10B981;">
            <h3 style="margin-top: 0; color: #1F2937;">${courseName}</h3>
            <p style="font-size: 24px; font-weight: bold; color: #10B981; margin: 10px 0;">${percentage}% OFF</p>
            <p style="margin-bottom: 0; color: #666;">Valid for ${days} days</p>
          </div>
          <p>Your discount is now live! Students will see the discounted price and countdown timer.</p>
          <a href="${process.env.CLIENT_URL}/instructor/courses" style="display: inline-block; background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 10px;">
            View Course
          </a>
          <p style="margin-top: 20px; color: #666;">Best regards,<br>The ${process.env.FROM_NAME} Team</p>
        </div>
      `
    });
  } catch (error) {
    console.error('Error sending discount approved email:', error);
  }
};

// Send email to students when course has discount
const sendDiscountAnnouncementEmail = async (studentEmail, studentName, courseName, percentage, days) => {
  try {
    await sendEmail({
      email: studentEmail,
      subject: `🎉 Limited Time Offer: ${percentage}% OFF ${courseName}!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #EF4444;">🔥 Limited Time Discount!</h2>
          <p>Hi ${studentName},</p>
          <p>Great news! A course you might be interested in is now on sale:</p>
          <div style="background-color: #FEF2F2; padding: 20px; border-radius: 5px; margin: 15px 0; border: 2px solid #EF4444;">
            <h3 style="margin-top: 0; color: #1F2937;">${courseName}</h3>
            <p style="font-size: 32px; font-weight: bold; color: #EF4444; margin: 10px 0;">SAVE ${percentage}%</p>
            <p style="color: #666; font-size: 14px;">⏰ Offer ends in ${days} days!</p>
          </div>
          <p style="color: #DC2626; font-weight: bold;">Don't miss this limited-time opportunity!</p>
          <a href="${process.env.CLIENT_URL}/courses" style="display: inline-block; background-color: #EF4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 10px; font-weight: bold;">
            Enroll Now
          </a>
          <p style="margin-top: 20px; color: #666;">Best regards,<br>The ${process.env.FROM_NAME} Team</p>
        </div>
      `
    });
  } catch (error) {
    console.error('Error sending discount announcement email:', error);
  }
};

module.exports = {
  sendInstructorApprovalEmail,
  sendNewCourseEmail,
  sendNewContentEmail,
  sendAssignmentGradedEmail,
  sendCertificateReceivedEmail,
  sendMessageNotificationEmail,
  sendNewDiscountEmail,
  sendDiscountAnnouncementEmail
};
