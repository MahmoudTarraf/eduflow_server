const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const InstructorApplication = require('../models/InstructorApplication');
const User = require('../models/User');
const AdminSettings = require('../models/AdminSettings');
const { sendEmail } = require('../utils/sendEmail');
const { isDisposableEmail } = require('../utils/disposableEmail');
const { constructUploadPath, constructFileUrl, constructClientUrl } = require('../utils/urlHelper');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { isPasswordStrong } = require('../utils/passwordStrength');

// @desc    Register instructor (Step 1)
// @route   POST /api/auth/register-instructor
// @access  Public
exports.registerInstructor = async (req, res) => {
  try {
    const { name, email, password, phone, country, expertise, profilePhoto } = req.body;

    if (isDisposableEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Disposable or temporary email addresses are not allowed. Please use a real email address.'
      });
    }

    if (!isPasswordStrong(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password does not meet security requirements. It must be at least 12 characters and include uppercase, lowercase, number, and special character.'
      });
    }

    // Check if application already exists
    const existingApplication = await InstructorApplication.findOne({ email });
    if (existingApplication) {
      // If email is not verified, delete the old application and allow re-registration
      if (!existingApplication.emailVerified) {
        await InstructorApplication.findByIdAndDelete(existingApplication._id);
        console.log(`[Instructor Registration] Deleted unverified application for ${email}`);
      } else {
        // Return current progress information for verified applications
        return res.status(200).json({
          success: true,
          isExisting: true,
          registrationProgress: existingApplication.registrationProgress,
          emailVerified: existingApplication.emailVerified,
          status: existingApplication.status,
          name: existingApplication.name,
          message: 'Application in progress. Redirecting to current step...'
        });
      }
    }

    // Check if user already exists (ignore soft-deleted users)
    const existingUser = await User.findActiveByEmail(email);
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'A user with this email already exists'
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const now = new Date();

    // Create application
    const application = await InstructorApplication.create({
      name,
      email,
      passwordHash,
      phone,
      country,
      expertise,
      profilePhoto,
      emailVerificationOTP: otp,
      emailVerificationExpires: otpExpires,
      registrationProgress: 1,
      lastOtpSentAt: now
    });

    // Notify admins that pending instructor application counts changed
    try {
      const io = req.app.get('io');
      if (io) {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
      }
    } catch (e) {
      console.error('Failed to emit pending summary update after instructor registration:', e.message);
    }

    // Send verification email
    try {
      await sendEmail({
        email: application.email,
        subject: 'Verify Your Email - EduFlow Instructor Registration',
        html: `
          <h2>Welcome to EduFlow!</h2>
          <p>Hi ${application.name},</p>
          <p>Thank you for applying to become an instructor on EduFlow. Please verify your email address using the code below:</p>
          <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
            <h1 style="color: #4f46e5; font-size: 32px; letter-spacing: 5px; margin: 0;">${otp}</h1>
          </div>
          <p>This code will expire in 10 minutes.</p>
          <p>If you didn't request this, please ignore this email.</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `
      });
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError);
      // Continue anyway - user can request resend
    }

    res.status(201).json({
      success: true,
      message: 'Application created. Please check your email for verification code.'
    });
  } catch (error) {
    console.error('Register instructor error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
};

// @desc    Verify instructor email (Step 2)
// @route   POST /api/auth/verify-instructor-email
// @access  Public
exports.verifyInstructorEmail = async (req, res) => {
  try {
    const { email, otp } = req.body;

    const application = await InstructorApplication.findOne({ email });
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    if (application.emailVerified) {
      return res.status(400).json({
        success: false,
        message: 'Email already verified'
      });
    }

    // Check if OTP matches and hasn't expired
    if (application.emailVerificationOTP !== otp) {
      return res.status(400).json({
        success: false,
        message: 'Invalid verification code'
      });
    }

    if (application.emailVerificationExpires < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Verification code expired'
      });
    }

    // Update application
    application.emailVerified = true;
    application.emailVerificationOTP = undefined;
    application.emailVerificationExpires = undefined;
    application.registrationProgress = 2;
    await application.save();

    // Notify admins that pending instructor application counts changed
    try {
      const io = req.app.get('io');
      if (io) {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
      }
    } catch (e) {
      console.error('Failed to emit pending summary update after application approval:', e.message);
    }

    res.json({
      success: true,
      message: 'Email verified successfully'
    });
  } catch (error) {
    console.error('Verify instructor email error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Resend verification OTP
// @route   POST /api/auth/resend-instructor-otp
// @access  Public
exports.resendInstructorOTP = async (req, res) => {
  try {
    const { email } = req.body;

    const application = await InstructorApplication.findOne({ email });
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    if (application.emailVerified) {
      return res.status(400).json({
        success: false,
        message: 'Email already verified'
      });
    }

    // Generate new OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

    application.emailVerificationOTP = otp;
    application.emailVerificationExpires = otpExpires;
    application.lastOtpSentAt = new Date();
    await application.save();

    // Send email
    await sendEmail({
      email: application.email,
      subject: 'New Verification Code - EduFlow',
      html: `
        <h2>New Verification Code</h2>
        <p>Hi ${application.name},</p>
        <p>Your new verification code is:</p>
        <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
          <h1 style="color: #4f46e5; font-size: 32px; letter-spacing: 5px; margin: 0;">${otp}</h1>
        </div>
        <p>This code will expire in 10 minutes.</p>
      `
    });

    res.json({
      success: true,
      message: 'New verification code sent'
    });
  } catch (error) {
    console.error('Resend OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Generate instructor agreement PDF (Step 3)
// @route   POST /api/instructor/generate-agreement
// @access  Public
exports.generateAgreement = async (req, res) => {
  try {
    const { email, name, signature } = req.body;

    const application = await InstructorApplication.findOne({ email });
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    if (!application.emailVerified) {
      return res.status(400).json({
        success: false,
        message: 'Please verify your email first'
      });
    }

    // Get platform settings from AdminSettings
    const settings = await AdminSettings.getSettings();
    const platformName = settings.platformName || 'EduFlow Academy';
    const platformEmail = settings.platformEmail || '';
    const platformCommission = settings.platformRevenuePercentage || 30;
    const instructorCommission = settings.instructorRevenuePercentage || 70;
    const agreementText = settings.agreementText || '';

    // Generate PDF
    const doc = new PDFDocument({ margin: 50 });
    const uploadsDir = path.join(__dirname, '../uploads/agreements');
    
    // Create uploads directory if it doesn't exist
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const fileName = `agreement_${email.replace('@', '_')}_${Date.now()}.pdf`;
    const filePath = path.join(uploadsDir, fileName);
    const writeStream = fs.createWriteStream(filePath);

    doc.pipe(writeStream);

    // Add logo if available
    if (settings.logoUrl) {
      try {
        const logoPath = path.join(__dirname, '..', settings.logoUrl);
        if (fs.existsSync(logoPath)) {
          doc.image(logoPath, 50, 45, { width: 100 });
          doc.moveDown(3);
        }
      } catch (err) {
        console.error('Error adding logo to PDF:', err);
      }
    }

    // PDF Header
    doc.fontSize(24).fillColor('#4F46E5').text(`${platformName.toUpperCase()} INSTRUCTOR AGREEMENT`, { align: 'center' });
    doc.fillColor('#000000');
    doc.moveDown();
    doc.fontSize(10).text(`Date: ${new Date().toLocaleDateString()}`, { align: 'right' });
    doc.fontSize(10).text(`Platform Email: ${platformEmail || 'N/A'}`, { align: 'right' });
    doc.moveDown(2);

    // Parties Information
    doc.fontSize(12).fillColor('#1F2937').text('PLATFORM (FIRST PARTY)', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor('#000000');
    doc.text(`Name: ${platformName}`);
    doc.text(`Email: ${platformEmail || 'N/A'}`);
    doc.moveDown(1.5);

    doc.fontSize(12).fillColor('#1F2937').text('INSTRUCTOR (SECOND PARTY)', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor('#000000');
    doc.text(`Name: ${name}`);
    doc.text(`Email: ${email}`);
    doc.moveDown(1.5);

    // Agreement Text
    doc.fontSize(12).fillColor('#1F2937').text('AGREEMENT TERMS', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor('#000000');
    
    // Replace placeholders in agreement text
    const finalAgreementText = agreementText
      .replace(/{platformPercentage}/g, platformCommission)
      .replace(/{instructorPercentage}/g, instructorCommission);
    
    doc.text(finalAgreementText, {
      align: 'justify',
      lineGap: 3
    });
    doc.moveDown(1.5);

    // Revenue Sharing Terms (clear and explicit)
    doc.fontSize(12).fillColor('#1F2937').text('REVENUE SHARING TERMS', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor('#000000');
    doc.text(`Platform Commission (${platformName} share): ${platformCommission}%`);
    doc.text(`Instructor Share (your share after platform commission): ${instructorCommission}%`);
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor('#000000').text(
      'For every valid student payment, the platform keeps its commission percentage and you receive the remaining instructor percentage.'
    );
    // Simple illustrative example on a 100,000 SYP payment
    const exampleBase = 100000;
    const platformAmt = Math.round(exampleBase * (platformCommission / 100));
    const instructorAmt = exampleBase - platformAmt;
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#374151').text(
      `Example on 100,000 SYP: Payment = 100,000 SYP | Platform ${platformCommission}% = ${platformAmt.toLocaleString()} SYP | Instructor ${instructorCommission}% = ${instructorAmt.toLocaleString()} SYP`
    );
    doc.moveDown(2);

    // Signature Section
    doc.fontSize(12).fillColor('#1F2937').text('SIGNATURES', { underline: true });
    doc.moveDown(0.5);

    // Instructor signature
    doc.fontSize(11).fillColor('#000000').text('Instructor:', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(16).font('Helvetica-Oblique').fillColor('#4F46E5').text(signature, { indent: 20 });
    doc.font('Helvetica').fillColor('#000000');
    doc.fontSize(10);
    doc.text(`Name: ${name}`);
    doc.text(`Email: ${email}`);
    doc.text(`Date: ${new Date().toLocaleDateString()}`);
    doc.moveDown(1.5);

    // Platform signature (electronic)
    doc.fontSize(11).fillColor('#000000').text('Platform (First Party):', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10);
    doc.text(`Platform Name: ${platformName}`);
    doc.text(`Platform Email: ${platformEmail || 'N/A'}`);
    doc.text('This agreement is electronically issued by the platform and considered signed by the authorized representative.');
    doc.moveDown(2);
    
    // Footer
    doc.fontSize(9).fillColor('#6B7280').text(
      'This is a legally binding agreement. By signing, you accept all terms and conditions.',
      { align: 'center' }
    );

    doc.end();

    // Wait for PDF to finish writing
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // Store relative path in database, construct full URL when needed
    const pdfUrl = constructUploadPath('agreements', fileName);

    // Update application
    application.agreementPdfUrl = pdfUrl;
    application.signature = signature;
    application.agreementSignedAt = new Date();
    application.registrationProgress = 3;
    await application.save();

    res.json({
      success: true,
      message: 'Agreement generated successfully',
      pdfUrl
    });
  } catch (error) {
    console.error('Generate agreement error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Save introduction video (Step 4)
// @route   POST /api/instructor/save-intro-video
// @access  Public
exports.saveIntroVideo = async (req, res) => {
  try {
    const { email, videoUrl } = req.body;

    const application = await InstructorApplication.findOne({ email });
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    if (!application.agreementPdfUrl) {
      return res.status(400).json({
        success: false,
        message: 'Please complete the agreement first'
      });
    }

    // Update application
    application.introVideoUrl = videoUrl;
    application.registrationProgress = 5;
    application.status = 'pending_review';
    await application.save();

    // Notify admin
    try {
      const admin = await User.findOne({ role: 'admin' });
      if (admin) {
        await sendEmail({
          email: admin.email,
          subject: 'New Instructor Application - EduFlow',
          html: `
            <h2>New Instructor Application</h2>
            <p>A new instructor has completed their application:</p>
            <p><strong>Name:</strong> ${application.name}</p>
            <p><strong>Email:</strong> ${application.email}</p>
            <p><strong>Expertise:</strong> ${application.expertise.join(', ')}</p>
            <p>Please review the application in your admin dashboard.</p>
          `
        });
      }
    } catch (emailError) {
      console.error('Failed to notify admin:', emailError);
    }

    // Send confirmation email to instructor
    try {
      await sendEmail({
        email: application.email,
        subject: 'Application Received - EduFlow',
        html: `
          <h2>Thank you for applying to EduFlow!</h2>
          <p>Dear ${application.name},</p>
          <p>We have successfully received your instructor application.</p>
          <p>Our admin team will review your application and respond within <strong>2 business days</strong>.</p>
          <p>You will receive an email notification once your application has been reviewed.</p>
          <br/>
          <p>Thank you for your patience!</p>
          <p>Best regards,<br/>The EduFlow Team</p>
        `
      });
    } catch (emailError) {
      console.error('Failed to send confirmation email to instructor:', emailError);
    }

    res.json({
      success: true,
      message: 'Application submitted successfully! An admin will review and respond to your request within 2 days.',
      waitMessage: 'Admin will approve/respond within 2 days'
    });
  } catch (error) {
    console.error('Save intro video error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get all pending instructor applications (Admin)
// @route   GET /api/admin/instructor-applications
// @access  Private (Admin)
exports.getPendingApplications = async (req, res) => {
  try {
    const applications = await InstructorApplication.find({ status: 'pending_review' })
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      applications
    });
  } catch (error) {
    console.error('Get applications error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Approve instructor application (Admin)
// @route   PUT /api/admin/instructor-applications/:id/approve
// @access  Private (Admin)
exports.approveApplication = async (req, res) => {
  try {
    const application = await InstructorApplication.findById(req.params.id);
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    // Create instructor user account
    // NOTE: New instructors start with NO courses. Courses are created later by the instructor
    // and are tied to exactly ONE instructor via the Course.instructor field
    const user = await User.create({
      name: application.name,
      email: application.email,
      password: application.passwordHash, // Already hashed
      phone: application.phone,
      country: application.country,
      role: 'instructor',
      instructorStatus: 'approved',
      isEmailVerified: true,
      expertise: application.expertise, // Copy expertise from application
      agreementPdfUrl: application.agreementPdfUrl // Store agreement PDF URL in user profile
    });

    // Create InstructorAgreement document with video
    const InstructorAgreement = require('../models/InstructorAgreement');
    const fs = require('fs');
    const path = require('path');
    
    // Check if video file exists and prepare video data with all required fields
    let introductionVideoData = null;
    if (application.introVideoUrl) {
      const videoFilename = application.introVideoUrl.split('/').pop();
      const videoPath = path.join(__dirname, '..', application.introVideoUrl);
      
      // Get file stats if file exists
      let fileSize = 0;
      try {
        if (fs.existsSync(videoPath)) {
          const stats = fs.statSync(videoPath);
          fileSize = stats.size;
        } else {
          // If file doesn't exist, use a default size
          fileSize = 10485760; // 10MB default
        }
      } catch (err) {
        console.log('Could not get video file size:', err.message);
        fileSize = 10485760; // 10MB default
      }
      
      introductionVideoData = {
        originalName: videoFilename,
        storedName: videoFilename,
        url: application.introVideoUrl,
        mimeType: 'video/mp4', // Default to mp4
        size: fileSize,
        uploadedAt: new Date()
      };
    }
    
    // Snapshot the percentages at approval time so they can be used as last agreed terms
    const currentSettings = await AdminSettings.getSettings();
    const currentInstructorPct = currentSettings?.instructorRevenuePercentage ?? 70;

    const agreementData = {
      instructor: user._id,
      agreedToTerms: true, // Required field
      agreementText: application.agreementText || currentSettings?.agreementText || 'Standard Instructor Agreement',
      instructorPercentage: currentInstructorPct,
      status: 'approved', // Must be 'pending', 'approved', or 'rejected'
      reviewedAt: new Date()
    };
    
    // Only add introductionVideo if we have video data
    if (introductionVideoData) {
      agreementData.introductionVideo = introductionVideoData;
    }
    
    await InstructorAgreement.create(agreementData);

    // Update application with user reference
    application.status = 'approved';
    application.userId = user._id; // Link to created user account
    application.reviewedBy = req.user.id;
    application.reviewedAt = new Date();
    await application.save();

    // Send approval email with agreement PDF attached
    try {
      const fs = require('fs');
      const path = require('path');
      
      const emailOptions = {
        email: application.email,
        subject: 'Congratulations! Your Instructor Application Approved - EduFlow',
        html: `
          <h2>Congratulations!</h2>
          <p>Hi ${application.name},</p>
          <p>Great news! Your instructor application has been approved.</p>
          <p>You can now log in to your account and start creating courses.</p>
          <p><strong>Email:</strong> ${application.email}</p>
          <p>Login at: ${constructClientUrl('/login')}</p>
          <br>
          <p>Your signed instructor agreement is attached to this email for your records. You can also view it anytime in your dashboard.</p>
          <br>
          <p>Welcome to the EduFlow instructor community!</p>
          <p>Best regards,<br>EduFlow Team</p>
        `
      };
      
      // Attach PDF agreement if available
      if (application.agreementPdfUrl) {
        const pdfPath = path.join(__dirname, '..', application.agreementPdfUrl);
        if (fs.existsSync(pdfPath)) {
          emailOptions.attachments = [
            {
              filename: `${application.name}_Instructor_Agreement.pdf`,
              path: pdfPath
            }
          ];
        }
      }
      
      await sendEmail(emailOptions);
    } catch (emailError) {
      console.error('Failed to send approval email:', emailError);
    }

    res.json({
      success: true,
      message: 'Application approved successfully'
    });
  } catch (error) {
    console.error('Approve application error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Delete incomplete instructor application (allows restart)
// @route   DELETE /api/auth/instructor-application
// @access  Public
exports.deleteIncompleteApplication = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const application = await InstructorApplication.findOne({ email });
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'No application found with this email'
      });
    }

    // Only allow deletion of incomplete applications (not approved or under review)
    if (application.status === 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete approved applications. Please contact support.'
      });
    }

    await application.deleteOne();

    res.json({
      success: true,
      message: 'Application deleted successfully. You can now restart the registration process.'
    });
  } catch (error) {
    console.error('Delete incomplete application error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Reject instructor application (Admin)
// @route   PUT /api/admin/instructor-applications/:id/reject
// @access  Private (Admin)
exports.rejectApplication = async (req, res) => {
  try {
    const { reason } = req.body;
    const application = await InstructorApplication.findById(req.params.id);
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    // Send rejection email before deleting
    try {
      await sendEmail({
        email: application.email,
        subject: 'Instructor Application Update - EduFlow',
        html: `
          <h2>Application Update</h2>
          <p>Hi ${application.name},</p>
          <p>Thank you for your interest in becoming an instructor on EduFlow.</p>
          <p>Unfortunately, we are unable to approve your application at this time.</p>
          ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
          <p>You may reapply in the future if circumstances change.</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `
      });
    } catch (emailError) {
      console.error('Failed to send rejection email:', emailError);
    }

    // Delete the application instead of marking as rejected
    // This allows the instructor to reapply with the same email
    await application.deleteOne();

    // Notify admins that pending instructor application counts changed
    try {
      const io = req.app.get('io');
      if (io) {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
      }
    } catch (e) {
      console.error('Failed to emit pending summary update after application rejection:', e.message);
    }

    res.json({
      success: true,
      message: 'Application rejected and deleted. Instructor can reapply if needed.'
    });
  } catch (error) {
    console.error('Reject application error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Upload instructor introduction video
// @route   POST /api/instructor/upload-intro-video
// @access  Public
exports.uploadIntroVideo = async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Video file is required'
      });
    }
    
    // Find the application
    const application = await InstructorApplication.findOne({ email });
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }
    
    // Save video URL (relative path from server root)
    const videoUrl = `/uploads/instructor-videos/${req.file.filename}`;
    application.introVideoUrl = videoUrl;
    await application.save();
    
    console.log(`[VideoUpload] Video uploaded for ${email}: ${videoUrl}`);
    
    res.json({
      success: true,
      videoUrl,
      message: 'Video uploaded successfully'
    });
  } catch (error) {
    console.error('Upload intro video error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
