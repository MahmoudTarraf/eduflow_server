/**
 * Default Privacy Policy and Terms of Service content
 * These are used when policies are first initialized
 */

const DEFAULT_PRIVACY_POLICY = `
<h1>Privacy Policy</h1>

<h2>1. Introduction</h2>
<p>Welcome to our platform. We are committed to protecting your privacy and ensuring you have a positive experience on our website. This Privacy Policy explains how we collect, use, disclose, and safeguard your information.</p>

<h2>2. Information We Collect</h2>
<p>We may collect information about you in a variety of ways. The information we may collect on the site includes:</p>
<ul>
  <li><strong>Personal Data:</strong> Name, email address, phone number, and other contact information you provide when registering or using our services.</li>
  <li><strong>Academic Information:</strong> Course enrollment, progress, grades, and submissions.</li>
  <li><strong>Usage Data:</strong> Information about how you interact with our platform, including pages visited, time spent, and features used.</li>
  <li><strong>Device Information:</strong> Browser type, IP address, and device identifiers.</li>
</ul>

<h2>3. How We Use Your Information</h2>
<p>We use the information we collect to:</p>
<ul>
  <li>Provide, maintain, and improve our educational services</li>
  <li>Process your registrations and manage your account</li>
  <li>Send you educational content and updates</li>
  <li>Respond to your inquiries and provide customer support</li>
  <li>Monitor and analyze platform usage and trends</li>
  <li>Comply with legal obligations</li>
</ul>

<h2>4. Data Security</h2>
<p>We implement appropriate technical and organizational measures to protect your personal data against unauthorized access, alteration, disclosure, or destruction. However, no method of transmission over the Internet is 100% secure.</p>

<h2>5. Third-Party Sharing</h2>
<p>We do not sell, trade, or rent your personal information to third parties. We may share information with service providers who assist us in operating our website and conducting our business, subject to confidentiality agreements.</p>

<h2>6. Your Rights</h2>
<p>You have the right to:</p>
<ul>
  <li>Access your personal data</li>
  <li>Request correction of inaccurate data</li>
  <li>Request deletion of your data</li>
  <li>Opt-out of marketing communications</li>
</ul>

<h2>7. Contact Us</h2>
<p>If you have questions about this Privacy Policy, please contact us at support@platform.com</p>

<p><em>Last Updated: ${new Date().toLocaleDateString()}</em></p>
`;

const DEFAULT_TERMS_OF_SERVICE = `
<h1>Terms of Service</h1>

<h2>1. Agreement to Terms</h2>
<p>By accessing and using this platform, you accept and agree to be bound by the terms and provision of this agreement. If you do not agree to abide by the above, please do not use this service.</p>

<h2>2. Use License</h2>
<p>Permission is granted to temporarily download one copy of the materials (information or software) on our platform for personal, non-commercial transitory viewing only. This is the grant of a license, not a transfer of title, and under this license you may not:</p>
<ul>
  <li>Modify or copy the materials</li>
  <li>Use the materials for any commercial purpose or for any public display</li>
  <li>Attempt to decompile or reverse engineer any software contained on the platform</li>
  <li>Remove any copyright or other proprietary notations from the materials</li>
  <li>Transfer the materials to another person or "mirror" the materials on any other server</li>
</ul>

<h2>3. Disclaimer</h2>
<p>The materials on our platform are provided on an 'as is' basis. We make no warranties, expressed or implied, and hereby disclaim and negate all other warranties including, without limitation, implied warranties or conditions of merchantability, fitness for a particular purpose, or non-infringement of intellectual property or other violation of rights.</p>

<h2>4. Limitations</h2>
<p>In no event shall our platform or its suppliers be liable for any damages (including, without limitation, damages for loss of data or profit, or due to business interruption) arising out of the use or inability to use the materials on our platform.</p>

<h2>5. Accuracy of Materials</h2>
<p>The materials appearing on our platform could include technical, typographical, or photographic errors. We do not warrant that any of the materials on our platform are accurate, complete, or current. We may make changes to the materials contained on our platform at any time without notice.</p>

<h2>6. Links</h2>
<p>We have not reviewed all of the sites linked to our website and are not responsible for the contents of any such linked site. The inclusion of any link does not imply endorsement by us of the site. Use of any such linked website is at the user's own risk.</p>

<h2>7. Modifications</h2>
<p>We may revise these terms of service for our platform at any time without notice. By using this platform, you are agreeing to be bound by the then current version of these terms of service.</p>

<h2>8. Governing Law</h2>
<p>These terms and conditions are governed by and construed in accordance with the laws of the jurisdiction in which the platform operates, and you irrevocably submit to the exclusive jurisdiction of the courts in that location.</p>

<h2>9. User Conduct</h2>
<p>Users agree not to:</p>
<ul>
  <li>Engage in any conduct that restricts or inhibits anyone's use or enjoyment of the platform</li>
  <li>Post, transmit, or distribute any unlawful, threatening, abusive, defamatory, obscene, or otherwise objectionable material</li>
  <li>Attempt to gain unauthorized access to our systems</li>
  <li>Violate any applicable laws or regulations</li>
</ul>

<h2>10. Contact Information</h2>
<p>If you have any questions about these Terms of Service, please contact us at support@platform.com</p>

<p><em>Last Updated: ${new Date().toLocaleDateString()}</em></p>
`;

module.exports = {
  DEFAULT_PRIVACY_POLICY,
  DEFAULT_TERMS_OF_SERVICE
};
