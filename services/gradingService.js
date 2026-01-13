const StudentContentGrade = require('../models/StudentContentGrade');
const StudentSectionGrade = require('../models/StudentSectionGrade');
const CourseGrade = require('../models/CourseGrade');
const Content = require('../models/Content');
const Section = require('../models/Section');
const TestAttempt = require('../models/TestAttempt');

/**
 * Calculate grade for a single content item
 * @param {Object} contentGrade - StudentContentGrade document
 * @param {Object} content - Content document
 * @returns {Number} Grade percentage (0-100)
 */
function calculateContentGrade(contentGrade, content) {
  if (!contentGrade) return 0;

  switch (content.type) {
    case 'lecture':
      // Lecture: 100% if watched, 0% otherwise
      return contentGrade.status === 'watched' ? 100 : 0;

    case 'assignment':
      // Assignment logic:
      // - not_delivered: 0%
      // - submitted_ungraded: 50%
      // - graded: instructor's grade (0-100)
      if (contentGrade.status === 'not_delivered') return 0;
      if (contentGrade.status === 'submitted_ungraded') return 50;
      if (contentGrade.status === 'graded') return contentGrade.gradePercent || 0;
      return 0;

    case 'project':
      // Project contains lecture + assignment
      // This is handled at the project level in calculateProjectGrade
      return contentGrade.gradePercent || 0;

    default:
      return 0;
  }
}

/**
 * Calculate grade for a project (which contains lecture + assignment)
 * @param {String} studentId - Student ID
 * @param {Object} projectContent - Project content document
 * @returns {Number} Project grade percentage (0-100)
 */
async function calculateProjectGrade(studentId, projectContent) {
  // A project should have associated lecture and assignment content
  // For now, we'll use the project's own grade if it has one
  const projectGrade = await StudentContentGrade.findOne({
    student: studentId,
    content: projectContent._id
  });

  if (!projectGrade) return 0;

  // If the project has its own grading, use it
  // Otherwise, you could fetch related lecture/assignment and average them
  return calculateContentGrade(projectGrade, projectContent);
}

/**
 * Calculate aggregated grade for a section
 * Formula:
 * - lectures_score = sum(lecture_grades) / N (if N=0, treat as 0)
 * - assignments_score = sum(assignment_grades) / M (if M=0, treat as 0)
 * - projects_score = sum(project_grades) / P (if P=0, treat as 0)
 * - section_grade = average of available components
 * 
 * @param {String} studentId - Student ID
 * @param {String} sectionId - Section ID
 * @returns {Object} { sectionGrade, breakdown }
 */
async function calculateSectionGrade(studentId, sectionId) {
  try {
    // Get all content for this section
    const contents = await Content.find({
      section: sectionId,
      isPublished: true,
      deletionStatus: 'active',
      isLatestVersion: true
    });

    // Get all grades for this student in this section
    const contentIds = contents.map(c => c._id);
    const grades = await StudentContentGrade.find({
      student: studentId,
      content: { $in: contentIds }
    });

    const gradeMap = new Map();
    grades.forEach(g => {
      gradeMap.set(g.content.toString(), g);
    });

    let lectureSum = 0, lectureCount = 0;
    let assignmentSum = 0, assignmentCount = 0;
    let projectSum = 0, projectCount = 0;

    for (const content of contents) {
      const grade = gradeMap.get(content._id.toString());
      
      switch (content.type) {
        case 'lecture':
          lectureCount++;
          if (grade) {
            lectureSum += calculateContentGrade(grade, content);
          }
          break;

        case 'assignment':
          assignmentCount++;
          if (grade) {
            assignmentSum += calculateContentGrade(grade, content);
          }
          break;

        case 'project':
          projectCount++;
          if (grade) {
            projectSum += await calculateProjectGrade(studentId, content);
          }
          break;
      }
    }

    // Get test attempts for this section
    const ActiveTest = require('../models/ActiveTest');
    const tests = await ActiveTest.find({ section: sectionId, isActive: true });
    
    let testsScore = 0;
    let testsCount = tests.length;
    
    if (testsCount > 0) {
      let testsSum = 0;
      for (const test of tests) {
        // Get best attempt for this test
        const attempts = await TestAttempt.find({
          test: test._id,
          student: studentId,
          status: 'graded'
        }).sort({ score: -1 }).limit(1);
        
        if (attempts.length > 0) {
          testsSum += attempts[0].score || 0;
        }
        // If no attempts, score is 0 for this test
      }
      testsScore = testsSum / testsCount;
    }

    // Calculate averages for each type
    const lecturesScore = lectureCount > 0 ? lectureSum / lectureCount : 0;
    const assignmentsScore = assignmentCount > 0 ? assignmentSum / assignmentCount : 0;
    const projectsScore = projectCount > 0 ? projectSum / projectCount : 0;

    // Calculate section grade (average of available components)
    // Only include tests if there are tests in the section
    const availableComponents = [];
    if (lectureCount > 0) availableComponents.push(lecturesScore);
    if (assignmentCount > 0) availableComponents.push(assignmentsScore);
    if (projectCount > 0) availableComponents.push(projectsScore);
    if (testsCount > 0) availableComponents.push(testsScore);

    const sectionGrade = availableComponents.length > 0
      ? availableComponents.reduce((sum, val) => sum + val, 0) / availableComponents.length
      : 0;

    const roundedGrade = Math.round(sectionGrade * 100) / 100; // Round to 2 decimals

    return {
      sectionGrade: roundedGrade,
      breakdown: {
        lectures: Math.round(lecturesScore * 100) / 100,
        assignments: Math.round(assignmentsScore * 100) / 100,
        projects: Math.round(projectsScore * 100) / 100,
        tests: testsCount > 0 ? Math.round(testsScore * 100) / 100 : null,
        counts: {
          lectures: lectureCount,
          assignments: assignmentCount,
          projects: projectCount,
          tests: testsCount
        }
      }
    };
  } catch (error) {
    console.error('Error calculating section grade:', error);
    throw error;
  }
}

/**
 * Update and persist section grade in database
 * @param {String} studentId - Student ID
 * @param {String} sectionId - Section ID
 * @returns {Object} Updated section grade document
 */
async function updateSectionGrade(studentId, sectionId) {
  const { sectionGrade } = await calculateSectionGrade(studentId, sectionId);

  const updated = await StudentSectionGrade.findOneAndUpdate(
    { student: studentId, section: sectionId },
    { gradePercent: sectionGrade, updatedAt: new Date() },
    { upsert: true, new: true }
  );

  return updated;
}

/**
 * Calculate overall course grade for a student
 * Formula: course_grade = sum(section_grades) / number_of_sections
 * 
 * @param {String} studentId - Student ID
 * @param {String} courseId - Course ID
 * @param {String} groupId - Group ID (optional)
 * @returns {Object} { courseGrade, sectionGrades, stats }
 */
async function calculateCourseGrade(studentId, courseId, groupId = null) {
  try {
    // Get all sections for this course
    const sectionsQuery = { course: courseId, isActive: true };
    if (groupId) {
      sectionsQuery.group = groupId;
    }
    const sections = await Section.find(sectionsQuery);

    if (sections.length === 0) {
      return { courseGrade: 0, sectionGrades: [], stats: {} };
    }

    const sectionGrades = [];
    let totalGrade = 0;
    let sectionsCompleted = 0;
    
    // Aggregate statistics
    let lecturesTotal = 0, lecturesCompleted = 0, lecturesGradeSum = 0, lecturesCount = 0;
    let assignmentsTotal = 0, assignmentsCompleted = 0, assignmentsGradeSum = 0, assignmentsCount = 0;
    let projectsTotal = 0, projectsCompleted = 0, projectsGradeSum = 0, projectsCount = 0;

    for (const section of sections) {
      const { sectionGrade, breakdown } = await calculateSectionGrade(studentId, section._id);
      
      sectionGrades.push({
        sectionId: section._id,
        sectionName: section.name,
        grade: sectionGrade,
        breakdown
      });
      
      totalGrade += sectionGrade;
      
      // Count as completed only if student has engaged with content AND reached a passing grade
      // This prevents a single partial activity (e.g. one watched lecture in a multi-lecture section)
      // from marking the entire section, and thus course, as completed.
      const hasEngagement = breakdown && breakdown.counts && (
        (breakdown.counts.lectures > 0 && breakdown.lectures > 0) ||
        (breakdown.counts.assignments > 0 && breakdown.assignments > 0) ||
        (breakdown.counts.projects > 0 && breakdown.projects > 0) ||
        sectionGrade > 0
      );
      
      // Require a reasonable passing threshold (70%) before counting the section as completed
      if (hasEngagement && sectionGrade >= 70) {
        sectionsCompleted++;
      }
      
      // Aggregate content statistics
      if (breakdown && breakdown.counts) {
        lecturesTotal += breakdown.counts.lectures || 0;
        assignmentsTotal += breakdown.counts.assignments || 0;
        projectsTotal += breakdown.counts.projects || 0;
        
        // Estimate completed based on grade (100% = watched/submitted)
        const lecturesInSection = breakdown.counts.lectures || 0;
        const assignmentsInSection = breakdown.counts.assignments || 0;
        const projectsInSection = breakdown.counts.projects || 0;
        
        if (lecturesInSection > 0) {
          lecturesCompleted += Math.round((breakdown.lectures / 100) * lecturesInSection);
          lecturesGradeSum += breakdown.lectures;
          lecturesCount++;
        }
        
        if (assignmentsInSection > 0) {
          assignmentsCompleted += Math.round((breakdown.assignments / 100) * assignmentsInSection);
          assignmentsGradeSum += breakdown.assignments;
          assignmentsCount++;
        }
        
        if (projectsInSection > 0) {
          projectsCompleted += Math.round((breakdown.projects / 100) * projectsInSection);
          projectsGradeSum += breakdown.projects;
          projectsCount++;
        }
      }
    }

    const courseGrade = sections.length > 0 ? totalGrade / sections.length : 0;
    const roundedCourseGrade = Math.round(courseGrade * 100) / 100;
    
    // Calculate average grades for each content type
    const lecturesGrade = lecturesCount > 0 ? lecturesGradeSum / lecturesCount : 0;
    const assignmentsGrade = assignmentsCount > 0 ? assignmentsGradeSum / assignmentsCount : 0;
    const projectsGrade = projectsCount > 0 ? projectsGradeSum / projectsCount : 0;

    // Determine if course is complete
    // Course is complete if all sections are completed
    const isComplete = sections.length > 0 && sectionsCompleted >= sections.length;
    const completedAt = isComplete ? new Date() : null;

    console.log('[calculateCourseGrade] Setting completion status:', {
      studentId,
      courseId,
      sectionsCount: sections.length,
      sectionsCompleted,
      isComplete,
      completedAt
    });

    // Persist to CourseGrade model
    await CourseGrade.findOneAndUpdate(
      { student: studentId, course: courseId },
      {
        group: groupId,
        overallGrade: roundedCourseGrade,
        sectionsCount: sections.length,
        sectionsCompleted,
        isComplete,
        completedAt,
        lecturesTotal,
        lecturesCompleted,
        lecturesGrade: Math.round(lecturesGrade * 100) / 100,
        assignmentsTotal,
        assignmentsCompleted,
        assignmentsGrade: Math.round(assignmentsGrade * 100) / 100,
        projectsTotal,
        projectsCompleted,
        projectsGrade: Math.round(projectsGrade * 100) / 100,
        lastCalculated: new Date()
      },
      { upsert: true, new: true }
    );

    return {
      courseGrade: roundedCourseGrade,
      sectionGrades,
      stats: {
        sectionsCount: sections.length,
        sectionsCompleted,
        lecturesTotal,
        lecturesCompleted,
        lecturesGrade: Math.round(lecturesGrade * 100) / 100,
        assignmentsTotal,
        assignmentsCompleted,
        assignmentsGrade: Math.round(assignmentsGrade * 100) / 100,
        projectsTotal,
        projectsCompleted,
        projectsGrade: Math.round(projectsGrade * 100) / 100
      }
    };
  } catch (error) {
    console.error('Error calculating course grade:', error);
    throw error;
  }
}

/**
 * Record that a student watched a video lecture
 * @param {String} studentId - Student ID
 * @param {String} contentId - Content ID
 * @param {Number} watchedDuration - Duration watched in seconds
 * @param {Number} totalDuration - Total video duration in seconds
 * @returns {Object} Updated content grade
 */
async function recordVideoWatched(studentId, contentId, watchedDuration, totalDuration) {
  const content = await Content.findById(contentId);
  
  if (!content || content.type !== 'lecture') {
    throw new Error('Content is not a lecture');
  }

  // Calculate if watched >= 95% of duration
  const watchedPercent = totalDuration > 0 ? (watchedDuration / totalDuration) * 100 : 0;
  const isFullyWatched = watchedPercent >= 95;

  const grade = await StudentContentGrade.findOneAndUpdate(
    { student: studentId, content: contentId },
    {
      $set: {
        section: content.section,
        course: content.course,
        status: isFullyWatched ? 'watched' : 'not_delivered',
        gradePercent: isFullyWatched ? 100 : 0,
        watchedDuration,
        updatedAt: new Date()
      }
    },
    { upsert: true, new: true }
  );

  // Update section grade
  await updateSectionGrade(studentId, content.section);

  return grade;
}

/**
 * Record assignment or project submission
 * @param {String} studentId - Student ID
 * @param {String} contentId - Content ID (assignment or project)
 * @param {Object} fileInfo - File upload information
 * @returns {Object} Updated content grade
 */
async function recordAssignmentSubmission(studentId, contentId, fileInfo) {
  const content = await Content.findById(contentId);
  
  // Accept both assignments and projects for submission
  if (!content || (content.type !== 'assignment' && content.type !== 'project')) {
    throw new Error('Content is not an assignment or project');
  }

  console.log('[recordAssignmentSubmission]', {
    studentId,
    contentId,
    contentType: content.type,
    fileInfo: { originalName: fileInfo?.originalName, size: fileInfo?.size }
  });

  let grade = await StudentContentGrade.findOne({ student: studentId, content: contentId });

  if (!grade) {
    // First-time submission
    grade = await StudentContentGrade.create({
      student: studentId,
      content: contentId,
      section: content.section,
      course: content.course,
      status: 'submitted_ungraded',
      gradePercent: 50,
      submissionFile: fileInfo,
      reuploadRequested: false,
      reuploadStatus: 'none',
      updatedAt: new Date()
    });
  } else {
    // Existing grade record
    if (grade.status === 'graded') {
      // Treat as reupload – only allowed once and only if approved
      if (!grade.reuploadRequested || grade.reuploadStatus !== 'approved' || grade.reuploadUsed || grade.regradeUsed) {
        const err = new Error('Reupload not allowed for this assignment or project.');
        err.code = 'REUPLOAD_NOT_ALLOWED';
        throw err;
      }

      // Preserve original grade snapshot if not already stored
      if (!grade.initialGradePercent && grade.gradePercent != null) {
        grade.initialGradePercent = grade.gradePercent;
        grade.initialGradedAt = grade.gradedAt;
        grade.initialGradedBy = grade.gradedBy;
        grade.initialFeedback = grade.instructorFeedback;
      }

      grade.reuploadUsed = true;
      grade.reuploadSubmittedAt = new Date();
      grade.reuploadSubmissionFile = fileInfo;
      grade.status = 'submitted_ungraded';
      grade.gradePercent = 50;
      grade.updatedAt = new Date();
      await grade.save();
    } else if (grade.status === 'submitted_ungraded') {
      // Already submitted and waiting for grading
      const err = new Error('You have already submitted this item. Please wait for grading before requesting a reupload.');
      err.code = 'ALREADY_SUBMITTED';
      throw err;
    } else {
      // Fallback: treat as first submission for legacy states
      grade.section = content.section;
      grade.course = content.course;
      grade.submissionFile = fileInfo;
      grade.status = 'submitted_ungraded';
      grade.gradePercent = 50;
      grade.updatedAt = new Date();
      await grade.save();
    }
  }

  // Update section grade
  await updateSectionGrade(studentId, content.section);

  return grade;
}

/**
 * Grade an assignment (instructor action)
 * @param {String} studentId - Student ID
 * @param {String} contentId - Content ID
 * @param {Number} gradePercent - Grade (0-100)
 * @param {String} feedback - Instructor feedback
 * @param {String} gradedBy - Instructor ID
 * @returns {Object} Updated content grade
 */
async function gradeAssignment(studentId, contentId, gradePercent, feedback, gradedBy) {
  const content = await Content.findById(contentId);
  
  if (!content || (content.type !== 'assignment' && content.type !== 'project')) {
    throw new Error('Content is not an assignment or project');
  }

  // Validate grade
  const validGrade = Math.min(100, Math.max(0, gradePercent));

  const grade = await StudentContentGrade.findOneAndUpdate(
    { student: studentId, content: contentId },
    {
      $set: {
        section: content.section,
        course: content.course,
        status: 'graded',
        gradePercent: validGrade,
        instructorFeedback: feedback || '',
        gradedBy,
        gradedAt: new Date(),
        updatedAt: new Date()
      }
    },
    { upsert: true, new: true }
  );

  // Update section grade
  await updateSectionGrade(studentId, content.section);

  return grade;
}

module.exports = {
  calculateContentGrade,
  calculateProjectGrade,
  calculateSectionGrade,
  calculateCourseGrade,
  updateSectionGrade,
  recordVideoWatched,
  recordAssignmentSubmission,
  gradeAssignment
};
