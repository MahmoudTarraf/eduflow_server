const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { constructUploadPath } = require('./urlHelper');

/**
 * Generate Instructor Earnings Agreement PDF
 * @param {Object} agreementData - Agreement details
 * @returns {Promise<Object>} PDF URL and public ID
 */
exports.generateAgreementPDF = async (agreementData) => {
  const {
    instructorName,
    instructorEmail,
    instructorId,
    platformPercentage,
    instructorPercentage,
    agreementType,
    agreementVersion = '1.0',
    issuedDate = new Date(),
    platformName = 'EduFlow Academy',
    platformEmail = 'admin@eduflow.com',
    platformSignerName,
    agreementText
  } = agreementData;

  return new Promise((resolve, reject) => {
    try {
      // Create PDF document
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: 50,
          bottom: 50,
          left: 72,
          right: 72
        }
      });

      // Collect PDF chunks
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', async () => {
        try {
          const pdfBuffer = Buffer.concat(chunks);

          // Always save agreement PDFs to local storage (Cloudinary removed)
          console.log('💾 Saving agreement PDF to local storage');
          const agreementsDir = path.join(__dirname, '../uploads/agreements');

          // Create directory if it doesn't exist
          if (!fs.existsSync(agreementsDir)) {
            fs.mkdirSync(agreementsDir, { recursive: true });
          }

          const filename = `agreement_${instructorId}_${Date.now()}.pdf`;
          const filePath = path.join(agreementsDir, filename);

          // Write PDF to file
          fs.writeFileSync(filePath, pdfBuffer);

          resolve({
            pdfUrl: constructUploadPath('agreements', filename),
            pdfPublicId: null,
            localPath: filePath,
            storage: 'local'
          });
        } catch (error) {
          console.error('PDF save error:', error);
          reject(error);
        }
      });

      // Header with logo and title
      doc.fontSize(24)
         .fillColor('#4F46E5')
         .text(platformName, { align: 'center' })
         .moveDown(0.5);
      
      doc.fontSize(18)
         .fillColor('#1F2937')
         .text('Instructor Earnings Agreement', { align: 'center' })
         .moveDown(0.3);
      
      doc.fontSize(10)
         .fillColor('#6B7280')
         .text(`Agreement Version ${agreementVersion} | ${agreementType.toUpperCase()} AGREEMENT`, { align: 'center' })
         .moveDown(1.5);
      
      // Horizontal line
      doc.strokeColor('#E5E7EB')
         .lineWidth(1)
         .moveTo(72, doc.y)
         .lineTo(540, doc.y)
         .stroke()
         .moveDown(1);

      // Agreement Details Section
      doc.fontSize(12)
         .fillColor('#111827')
         .text('AGREEMENT DETAILS', { underline: true })
         .moveDown(0.5);
      
      doc.fontSize(10)
         .fillColor('#374151');
      
      // Date
      doc.text(`Issue Date: `, { continued: true })
         .fillColor('#1F2937')
         .text(new Date(issuedDate).toLocaleDateString('en-US', { 
           year: 'numeric', 
           month: 'long', 
           day: 'numeric' 
         }))
         .moveDown(0.3);
      
      // Agreement ID
      doc.fillColor('#374151')
         .text(`Agreement ID: `, { continued: true })
         .fillColor('#1F2937')
         .text(instructorId)
         .moveDown(1);

      // Parties Section
      doc.fontSize(12)
         .fillColor('#111827')
         .text('PARTIES TO THIS AGREEMENT', { underline: true })
         .moveDown(0.5);
      
      doc.fontSize(10)
         .fillColor('#374151');
      
      // Platform details
      doc.text('Platform (First Party):', { underline: false })
         .fillColor('#1F2937')
         .text(`   Name: ${platformName}`)
         .text(`   Email: ${platformEmail}`)
         .moveDown(0.5);
      
      // Instructor details
      doc.fillColor('#374151')
         .text('Instructor (Second Party):', { underline: false })
         .fillColor('#1F2937')
         .text(`   Name: ${instructorName}`)
         .text(`   Email: ${instructorEmail}`)
         .text(`   ID: ${instructorId}`)
         .moveDown(1);

      // Revenue Split Section (Highlighted)
      doc.rect(72, doc.y, 468, 80)
         .fillAndStroke('#EEF2FF', '#C7D2FE')
         .fillColor('#1F2937');
      
      const boxY = doc.y + 10;
      doc.y = boxY;
      
      doc.fontSize(12)
         .fillColor('#4338CA')
         .text('REVENUE SHARING TERMS', 82, boxY, { underline: true })
         .moveDown(0.5);
      
      doc.fontSize(11)
         .fillColor('#1F2937')
         .text(`Platform Commission: `, 82, doc.y, { continued: true })
         .fontSize(14)
         .fillColor('#DC2626')
         .text(`${platformPercentage}%`, { bold: true })
         .moveDown(0.3);
      
      doc.fontSize(11)
         .fillColor('#1F2937')
         .text(`Instructor Share: `, 82, doc.y, { continued: true })
         .fontSize(14)
         .fillColor('#059669')
         .text(`${instructorPercentage}%`, { bold: true })
         .moveDown(1.5);

      // Agreement Text
      doc.fontSize(12)
         .fillColor('#111827')
         .text('TERMS AND CONDITIONS', { underline: true })
         .moveDown(0.5);
      
      doc.fontSize(9)
         .fillColor('#374151');
      
      if (agreementText) {
        // Replace placeholders in agreement text
        const processedText = agreementText
          .replace(/{platformPercentage}/g, platformPercentage)
          .replace(/{instructorPercentage}/g, instructorPercentage)
          .replace(/{platformName}/g, platformName)
          .replace(/{instructorName}/g, instructorName);
        
        doc.text(processedText, {
          align: 'justify',
          lineGap: 3
        });
      } else {
        // Default agreement text
        doc.text(`1. REVENUE SHARING`, { underline: true })
           .moveDown(0.3)
           .text(`The Platform (${platformName}) will retain ${platformPercentage}% of all gross course revenue as a platform commission. The remaining ${instructorPercentage}% will be paid to the Instructor monthly.`, { align: 'justify' })
           .moveDown(0.5);
        
        doc.text(`2. PAYMENT TERMS`, { underline: true })
           .moveDown(0.3)
           .text(`Earnings will be calculated and paid out on the 1st of each month for the previous month's revenue. Payments are subject to a minimum threshold of $50 USD.`, { align: 'justify' })
           .moveDown(0.5);
        
        doc.text(`3. INSTRUCTOR RESPONSIBILITIES`, { underline: true })
           .moveDown(0.3)
           .text(`The Instructor agrees to: (a) Create high-quality educational content, (b) Respond to student inquiries promptly, (c) Maintain professional conduct, (d) Keep course materials current and accurate.`, { align: 'justify' })
           .moveDown(0.5);
        
        doc.text(`4. INTELLECTUAL PROPERTY`, { underline: true })
           .moveDown(0.3)
           .text(`The Instructor retains full ownership of course content but grants the Platform a non-exclusive license to host, distribute, and market the content.`, { align: 'justify' })
           .moveDown(0.5);
        
        doc.text(`5. TERMINATION`, { underline: true })
           .moveDown(0.3)
           .text(`Either party may terminate this agreement with 30 days written notice. Upon termination, final payments will be settled within 60 days.`, { align: 'justify' })
           .moveDown(0.5);
      }

      // Signature Section
      doc.addPage();
      
      doc.fontSize(12)
         .fillColor('#111827')
         .text('SIGNATURES', { underline: true })
         .moveDown(1);
      
      // Instructor signature
      doc.fontSize(10)
         .fillColor('#374151')
         .text('Instructor Signature:', { underline: false })
         .moveDown(0.3);
      
      doc.text(`Name: ${instructorName}`)
         .moveDown(0.5);
      
      doc.strokeColor('#9CA3AF')
         .lineWidth(1)
         .moveTo(72, doc.y)
         .lineTo(300, doc.y)
         .stroke()
         .moveDown(0.3);
      
      doc.text('Signature: _________________________')
         .moveDown(0.3)
         .text(`Date: ${new Date().toLocaleDateString()}`)
         .moveDown(2);
      
      // Platform signature
      doc.text('Platform Signature:', { underline: false })
         .moveDown(0.3);
      
      doc.text(`Name: ${platformName}`)
         .moveDown(0.5);
      
      doc.strokeColor('#9CA3AF')
         .lineWidth(1)
         .moveTo(72, doc.y)
         .lineTo(300, doc.y)
         .stroke()
         .moveDown(0.3);
      
      doc.text('Authorized Signature: _________________________')
         .moveDown(0.3)
         .text(`Date: ${new Date().toLocaleDateString()}`)
         .moveDown(2);

      // Typed electronic signatures note
      doc.fontSize(9).fillColor('#374151')
         .text('Electronic Signatures', { underline: true })
         .moveDown(0.3)
         .fontSize(9)
         .fillColor('#4B5563')
         .text(`Instructor: Signed electronically by ${instructorName} on ${new Date(issuedDate).toLocaleDateString('en-US')}`)
         .moveDown(0.2)
         .text(`Platform: Signed electronically by ${platformSignerName || platformName} on ${new Date(issuedDate).toLocaleDateString('en-US')}`)
         .moveDown(1);

      // Footer
      doc.fontSize(8)
         .fillColor('#9CA3AF')
         .text(
           `This is a legally binding agreement. Both parties should retain a copy for their records.\n` +
           `For questions or concerns, contact ${platformEmail}`,
           72,
           doc.page.height - 100,
           { align: 'center', width: 468 }
         );

      // Finalize PDF
      doc.end();
    } catch (error) {
      console.error('PDF generation error:', error);
      reject(error);
    }
  });
};

/**
 * Delete agreement PDF from local storage
 * @param {String} localPath - Local file path
 */
exports.deleteAgreementPDF = async (localPath) => {
  try {
    // Cloudinary has been removed; we only support local deletion now
    if (localPath) {
      // Delete from local storage
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
        console.log(`✅ Deleted agreement PDF from local storage: ${localPath}`);
      }
    }
  } catch (error) {
    console.error('Error deleting PDF:', error);
    throw error;
  }
};
