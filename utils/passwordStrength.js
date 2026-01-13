function isPasswordStrong(password) {
  if (typeof password !== 'string') return false;
  if (password.length < 12) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[!@#$%^&*()\-_=+\[\]{};:,.<>/?]/.test(password)) return false;
  return true;
}

function passwordStrengthCheck(password) {
  return {
    isStrong: isPasswordStrong(password),
    weakPassword: !isPasswordStrong(password)
  };
}

module.exports = {
  isPasswordStrong,
  passwordStrengthCheck
};
