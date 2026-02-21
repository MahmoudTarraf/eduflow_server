// testEmail.js
require('dotenv').config(); // load .env first
const { sendEmail } = require('./sendEmail'); // destructure correctly

async function testEmail() {
  try {
    await sendEmail({
      email: 'malk1milk2@gmail.com', // <-- must be 'email'
      subject: 'Test Email from Server',
      html: '<h2>Hello from EduFlow Server!</h2><p>This is a test email.</p>'
      // no attachments for now
    });
    console.log('✅ Email sent successfully!');
  } catch (err) {
    console.error('❌ Failed to send email:', err);
  }
}

// run test
testEmail();