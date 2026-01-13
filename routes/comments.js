const express = require('express');
const router = express.Router();
const Comment = require('../models/Comment');
const Content = require('../models/Content');
const { protect } = require('../middleware/auth');

// Get all comments for a content
router.get('/content/:contentId', protect, async (req, res) => {
  try {
    const { contentId } = req.params;
    
    // Verify content exists
    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({ message: 'Content not found' });
    }

    // Get all comments (both top-level and replies)
    const comments = await Comment.find({ content: contentId })
      .populate('user', 'name profilePicture')
      .populate({
        path: 'parentComment',
        populate: {
          path: 'user',
          select: 'name profilePicture'
        }
      })
      .sort({ createdAt: -1 });

    // Organize comments into a tree structure
    const topLevelComments = comments.filter(c => !c.parentComment);
    const commentMap = {};
    
    comments.forEach(comment => {
      commentMap[comment._id] = { ...comment.toObject(), replies: [] };
    });
    
    comments.forEach(comment => {
      if (comment.parentComment) {
        const parent = commentMap[comment.parentComment._id];
        if (parent) {
          parent.replies.push(commentMap[comment._id]);
        }
      }
    });

    const organizedComments = topLevelComments.map(c => commentMap[c._id]);

    res.json({
      success: true,
      data: organizedComments
    });
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add a new comment or reply
router.post('/content/:contentId', protect, async (req, res) => {
  try {
    const { contentId } = req.params;
    const { text, parentCommentId } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ message: 'Comment text is required' });
    }

    // Verify content exists
    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({ message: 'Content not found' });
    }

    // If replying to a comment, verify it exists
    if (parentCommentId) {
      const parentComment = await Comment.findById(parentCommentId);
      if (!parentComment) {
        return res.status(404).json({ message: 'Parent comment not found' });
      }
    }

    const comment = await Comment.create({
      content: contentId,
      user: req.user._id,
      text: text.trim(),
      parentComment: parentCommentId || null
    });

    // Populate user data before sending response
    await comment.populate('user', 'name profilePicture');

    res.status(201).json({
      success: true,
      data: comment
    });
  } catch (error) {
    console.error('Error creating comment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update a comment
router.put('/:commentId', protect, async (req, res) => {
  try {
    const { commentId } = req.params;
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ message: 'Comment text is required' });
    }

    const comment = await Comment.findById(commentId);
    
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    // Only allow user to edit their own comments
    if (comment.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to edit this comment' });
    }

    comment.text = text.trim();
    comment.updatedAt = Date.now();
    await comment.save();

    await comment.populate('user', 'name profilePicture');

    res.json({
      success: true,
      data: comment
    });
  } catch (error) {
    console.error('Error updating comment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a comment
router.delete('/:commentId', protect, async (req, res) => {
  try {
    const { commentId } = req.params;

    const comment = await Comment.findById(commentId);
    
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    // Only allow user or admin to delete comments
    const isOwner = comment.user.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';
    
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized to delete this comment' });
    }

    // Delete all replies to this comment
    await Comment.deleteMany({ parentComment: commentId });
    
    // Delete the comment itself
    await Comment.findByIdAndDelete(commentId);

    res.json({
      success: true,
      message: 'Comment deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
