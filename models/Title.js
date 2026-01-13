// Deprecated Title model
//
// All title-based gamification has been removed from the platform in favor of
// badges and point-based rewards only. This file is intentionally left without
// a Mongoose model definition so that MongoDB will no longer create or
// maintain a `titles` collection when the server starts.
//
// Keeping an empty export here ensures that any legacy
// require('../models/Title') calls (if any still exist) will not crash the
// app, while also preventing Mongoose from registering a `Title` model or
// touching the underlying collection.

module.exports = {};
