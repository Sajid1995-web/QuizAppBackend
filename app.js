require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { createObjectCsvWriter } = require("csv-writer");

const app = express();
const PORT = process.env.PORT || 3000;

// --------------- MIDDLEWARE ---------------
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-key'],
  credentials: true,
}));
app.use(express.json());

// --------------- FILE UPLOAD ---------------
const upload = multer({ dest: "uploads/" });
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Ensure results folder exists
const resultsDir = path.join(__dirname, "results");
if (!fs.existsSync(resultsDir)) {
  fs.mkdirSync(resultsDir, { recursive: true });
}

// --------------- MONGOOSE ---------------
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ============ MODELS ============
const ArchivedQuizRegistrationSchema = new mongoose.Schema(
  {
    regNo: {
      type: String,
      required: true,
      index: true,
    },

    quizName: {
      type: String,
      required: true,
      index: true,
    },

    registeredAt: {
      type: Date,
      default: Date.now,
    },

    customData: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },

    archivedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: "archivedquizregistrations",
  }
);

const ArchivedQuizRegistration =
  mongoose.model(
    "ArchivedQuizRegistration",
    ArchivedQuizRegistrationSchema
  );

const questionSchema = new mongoose.Schema({
  question: { type: String, required: true, trim: true },
  options: {
    A: { type: String, required: true },
    B: { type: String, required: true },
    C: { type: String, required: true },
    D: { type: String, required: true },
  },
  correctAnswer: { type: String, enum: ["A", "B", "C", "D"], required: true },
  imageUrl: { type: String, default: "" },
  published: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  quizName: { type: String, default: "" },
});
const Question = mongoose.model("Question", questionSchema);

const studentSchema = new mongoose.Schema({
  regNo: { type: String, unique: true, required: true },
  quizName: { type: String, default: "" },
  customData: { type: Map, of: String, default: () => new Map() },
  registeredAt: { type: Date, default: Date.now },
});
const Student = mongoose.model("Student", studentSchema);

const quizAttemptSchema = new mongoose.Schema({
  studentRegNo: { type: String, ref: "Student", required: true },
  quizName: { type: String, default: "" },
  startTime: Date,
  endTime: Date,
  answers: [String],
  score: { type: Number, default: null },
  totalMarksObtained: { type: Number, default: null },
  totalMarks: { type: Number, default: null },
  totalTimeMinutes: { type: Number, default: null },
  durationMinutes: { type: Number, default: 30 },
  positiveMarks: { type: Number, default: 1 },
  negativeMarks: { type: Number, default: 0 },
  disqualified: { type: Boolean, default: false },
  submitted: { type: Boolean, default: false },
  rank: { type: Number, default: null },
});
const QuizAttempt = mongoose.model("QuizAttempt", quizAttemptSchema);

const archivedAttemptSchema = new mongoose.Schema({
  studentRegNo: String,
  studentName: { type: String, default: "" },
  studentEmail: { type: String, default: "" },
  quizName: String,
  startTime: Date,
  endTime: Date,
  answers: [String],
  score: Number,
  totalMarksObtained: Number,
  totalMarks: Number,
  totalTimeMinutes: Number,
  durationMinutes: Number,
  positiveMarks: Number,
  negativeMarks: Number,
  disqualified: Boolean,
  submitted: Boolean,
  rank: Number,
  archivedAt: { type: Date, default: Date.now },
});
const ArchivedQuizAttempt = mongoose.model("ArchivedQuizAttempt", archivedAttemptSchema);

const examConfigSchema = new mongoose.Schema({
  quizName: { type: String, default: "Trivia Quiz" },
  startTime: { type: Date, required: true },
  durationMinutes: { type: Number, required: true, default: 30 },
  positiveMarks: { type: Number, default: 1 },
  negativeMarks: { type: Number, default: 0 },
  registrationFields: {
    type: Map,
    of: new mongoose.Schema({
      enabled: { type: Boolean, default: true },
      required: { type: Boolean, default: false },
    }),
    default: () => new Map(),
  },
  ranksFinalised: { type: Boolean, default: false },
    registrationOpen: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now },
  quizVersion: { type: Number, default: 1 },
  archived: { type: Boolean, default: false }, // NEW: flag to avoid re-archiving
});
const ExamConfig = mongoose.model("ExamConfig", examConfigSchema);

const counterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 },
});
const Counter = mongoose.model("Counter", counterSchema);

// ============ HELPERS ============

async function getExamConfig() {
  let config = await ExamConfig.findOne();
  if (!config) {
    config = new ExamConfig({
      quizName: "Trivia Quiz",
      startTime: process.env.QUIZ_START_TIME
        ? new Date(process.env.QUIZ_START_TIME)
        : new Date(Date.now() + 5 * 60000),
      durationMinutes: 30,
      positiveMarks: 1,
      negativeMarks: 0,
    });
    await config.save();
    console.log("📝 Default exam config created");
  }
  return config;
}


async function generateRegNo() {
  const config = await getExamConfig();
  const version = config.quizVersion || 1;
  const counterId = `regNo_${version}`;

  const counter = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `NSTAD-${String(counter.seq).padStart(4, '0')}Q-${version}`;
}

function getCsvPath(quizName) {
  const sanitized = quizName.replace(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(resultsDir, `results_${sanitized}.csv`);
}

function deleteCsvByQuizName(quizName) {
  const csvPath = getCsvPath(quizName);
  if (fs.existsSync(csvPath)) {
    fs.unlinkSync(csvPath);
    console.log(`🗑️ Deleted results CSV: ${csvPath}`);
    return true;
  }
  return false;
}

function getCustomDataObject(customData) {
  if (!customData) return {};
  if (customData instanceof Map) return Object.fromEntries(customData);
  if (typeof customData === 'object') return customData;
  return {};
}

function getCustomDataMap(customData) {
  if (!customData) return new Map();
  if (customData instanceof Map) return customData;
  if (typeof customData === 'object') {
    return new Map(Object.entries(customData));
  }
  return new Map();
}

async function rebuildCsv(quizName) {
  try {
    console.log(`🔄 Rebuilding CSV for quiz: "${quizName}"`);
    const attempts = await QuizAttempt.find({
      submitted: true,
      quizName: quizName,
    }).sort({ rank: 1 }).lean();

    if (attempts.length === 0) {
      // Create empty CSV (same as before)
      const csvPath = getCsvPath(quizName);
      const writer = createObjectCsvWriter({
        path: csvPath,
        header: [
          { id: "regNo", title: "RegNo" },
          { id: "name", title: "Name" },
          { id: "email", title: "Email" },
          { id: "correctCount", title: "Correct" },
          { id: "wrongCount", title: "Wrong" },
          { id: "totalMarksObtained", title: "MarksObtained" },
          { id: "totalMarks", title: "TotalMarks" },
          { id: "totalTimeMinutes", title: "TimeMinutes" },
          { id: "rank", title: "Rank" },
          { id: "timeOfSubmission", title: "SubmissionTime" },
          { id: "disqualified", title: "Disqualified" },
        ],
        append: false,
      });
      await writer.writeRecords([]);
      console.log(`📄 Results CSV created (empty) for "${quizName}"`);
      return;
    }

    const regNos = attempts.map(a => a.studentRegNo);
    const students = await Student.find({ regNo: { $in: regNos } }).lean();
    const studentMap = {};
    students.forEach(s => {
      studentMap[s.regNo] = getCustomDataObject(s.customData);
    });

    const allQuestions = await Question.find({ published: true, quizName }).sort({ createdAt: 1 }).lean();

    // Build initial records (without rank)
    const records = attempts.map((a) => {
      const custom = studentMap[a.studentRegNo] || {};
      const name = custom.name || "";
      const email = custom.email || "";
      const correct = a.score || 0;
      let wrong = 0;
      if (a.answers && allQuestions.length > 0) {
        a.answers.forEach((ans, idx) => {
          if (idx < allQuestions.length && ans !== null && ans !== "" && ans !== allQuestions[idx].correctAnswer) {
            wrong++;
          }
        });
      }
      return {
        regNo: a.studentRegNo,
        name,
        email,
        correctCount: correct,
        wrongCount: wrong,
        totalMarksObtained: a.totalMarksObtained || 0,
        totalMarks: a.totalMarks || 0,
        totalTimeMinutes: a.totalTimeMinutes || 0,
        rank: a.disqualified ? -1 : null, // we'll compute later
        timeOfSubmission: a.endTime?.toISOString() || "",
        disqualified: a.disqualified ? "YES" : "NO",
        // keep original object id for sorting tie‑breaker if needed
        _id: a._id,
        endTime: a.endTime,
      };
    });

    // Separate disqualified and non‑disqualified
    const disqualifiedRecords = records.filter(r => r.disqualified === "YES");
    const activeRecords = records.filter(r => r.disqualified === "NO");

    // Sort active by marks desc, time asc, then endTime asc (tie‑breaker)
    activeRecords.sort((a, b) => {
      if (b.totalMarksObtained !== a.totalMarksObtained)
        return b.totalMarksObtained - a.totalMarksObtained;
      if (a.totalTimeMinutes !== b.totalTimeMinutes)
        return a.totalTimeMinutes - b.totalTimeMinutes;
      // Tie‑breaker: earlier submission gets higher rank
      return (a.endTime?.getTime() || 0) - (b.endTime?.getTime() || 0);
    });

    // Assign ranks (dense ranking: ties get same rank, next rank skips)
    let currentRank = 1;
    for (let i = 0; i < activeRecords.length; i++) {
      const curr = activeRecords[i];
      if (i > 0) {
        const prev = activeRecords[i - 1];
        if (curr.totalMarksObtained === prev.totalMarksObtained &&
            curr.totalTimeMinutes === prev.totalTimeMinutes) {
          // same rank
          curr.rank = prev.rank;
          continue;
        }
      }
      curr.rank = currentRank;
      currentRank++;
    }

    // Disqualified get rank -1 (already set)
    // Combine: disqualified at the end (sorted by rank -1, but we can just put them last)
    const finalRecords = [...activeRecords, ...disqualifiedRecords];

    // Write CSV
    const csvPath = getCsvPath(quizName);
    const writer = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: "regNo", title: "RegNo" },
        { id: "name", title: "Name" },
        { id: "email", title: "Email" },
        { id: "correctCount", title: "Correct" },
        { id: "wrongCount", title: "Wrong" },
        { id: "totalMarksObtained", title: "MarksObtained" },
        { id: "totalMarks", title: "TotalMarks" },
        { id: "totalTimeMinutes", title: "TimeMinutes" },
        { id: "rank", title: "Rank" },
        { id: "timeOfSubmission", title: "SubmissionTime" },
        { id: "disqualified", title: "Disqualified" },
      ],
      append: false,
    });
    await writer.writeRecords(finalRecords);
    console.log(`✅ Results CSV rebuilt for quiz "${quizName}" -> ${csvPath}`);
  } catch (error) {
    console.error("❌ Error rebuilding CSV:", error);
    throw error;
  }
}

function getRegistrationCsvPath(quizName) {
  const sanitized = quizName.replace(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(resultsDir, `registrations_${sanitized}.csv`);
}

async function rebuildRegistrationCsv(quizName) {
  const students = await Student.find({ quizName: quizName }).sort({ registeredAt: 1 }).lean();
  const csvPath = getRegistrationCsvPath(quizName);

  if (students.length === 0) {
    const header = [
      { id: "regNo", title: "RegNo" },
      { id: "registeredAt", title: "Registration Time" },
    ];
    const writer = createObjectCsvWriter({
      path: csvPath,
      header,
      append: false,
    });
    await writer.writeRecords([]);
    console.log(`📄 Registration CSV created (empty) for "${quizName}"`);
    return;
  }

  const allCustomKeys = new Set();
  students.forEach(s => {
    const data = getCustomDataMap(s.customData);
    data.forEach((_, key) => allCustomKeys.add(key));
  });
  allCustomKeys.add('name');
  allCustomKeys.add('email');
  const sortedKeys = Array.from(allCustomKeys).sort();

  const header = [
    { id: "regNo", title: "RegNo" },
    { id: "registeredAt", title: "Registration Time" },
  ];
  sortedKeys.forEach(key => {
    header.push({ id: key, title: key.charAt(0).toUpperCase() + key.slice(1) });
  });

  const records = students.map(s => {
    const data = getCustomDataMap(s.customData);
    const record = {
      regNo: s.regNo,
      registeredAt: s.registeredAt.toISOString(),
    };
    sortedKeys.forEach(key => {
      record[key] = data.get(key) || "";
    });
    return record;
  });

  const writer = createObjectCsvWriter({
    path: csvPath,
    header,
    append: false,
  });
  await writer.writeRecords(records);
  console.log(`📄 Registration CSV rebuilt for "${quizName}" -> ${csvPath}`);
}
let watcherInterval = null;
let watcherRunning = false;

function startRankWatcher() {
  // ------------------------------------------------------------
  // Prevent duplicate watcher intervals
  // ------------------------------------------------------------
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }

  // ------------------------------------------------------------
  // Run immediately once
  // Then continue every 30 seconds
  // ------------------------------------------------------------
  const checkQuizLifecycle = async () => {
    // Prevent overlapping watcher executions
    if (watcherRunning) {
      console.log(
        "⏭️ Rank watcher already running, skipping this cycle."
      );
      return;
    }

    watcherRunning = true;

    try {
      const config = await getExamConfig();

      if (!config) {
        console.log(
          "⚠️ No exam configuration found."
        );
        return;
      }

      const quizName =
        config.quizName || "Trivia Quiz";

      const startTime =
        new Date(config.startTime).getTime();

      const durationMinutes =
        Number(config.durationMinutes) || 30;

      const endTime =
        startTime +
        durationMinutes * 60 * 1000;

      const now = Date.now();

      // ----------------------------------------------------------
      // EXAM HAS NOT STARTED
      // ----------------------------------------------------------
      if (now < startTime) {
        return;
      }

      // ----------------------------------------------------------
      // EXAM IS CURRENTLY RUNNING
      // ----------------------------------------------------------
      if (
        now >= startTime &&
        now <= endTime
      ) {
        // Do NOT finalize.
        // Do NOT archive.
        //
        // Students must be able to submit normally.
        return;
      }

      // ----------------------------------------------------------
      // EXAM HAS ENDED
      // ----------------------------------------------------------
      console.log(
        `⏰ Exam "${quizName}" has ended.`
      );

      // ----------------------------------------------------------
      // STEP 1:
      // Finalize ranks ONLY if they haven't already been finalized.
      //
      // finalizeRanks() no longer archives attempts.
      // ----------------------------------------------------------
      let latestConfig =
        await ExamConfig.findOne();

      if (!latestConfig) {
        console.log(
          "⚠️ Exam configuration disappeared."
        );
        return;
      }

      if (!latestConfig.ranksFinalised) {
        console.log(
          `⏳ Finalising ranks for "${quizName}"...`
        );

        await finalizeRanks();

        console.log(
          `✅ Rank finalisation completed for "${quizName}".`
        );

        // Reload config because finalizeRanks()
        // changes ranksFinalised.
        latestConfig =
          await ExamConfig.findOne();

        if (!latestConfig) {
          return;
        }
      } else {
        console.log(
          `ℹ️ Ranks already finalised for "${quizName}".`
        );
      }

      // ----------------------------------------------------------
      // STEP 2:
      // ARCHIVE ONLY AFTER RANKS ARE FINALIZED
      //
      // This is intentionally separate from finalizeRanks().
      // ----------------------------------------------------------
      if (!latestConfig.archived) {
        console.log(
          `🗄️ Starting archive for "${quizName}"...`
        );

        const archivedCount =
          await autoArchiveQuiz(
            quizName
          );

        // --------------------------------------------------------
        // Mark the quiz archived ONLY after archive operation
        // successfully completes.
        // --------------------------------------------------------
        await ExamConfig.updateOne(
          {},
          {
            $set: {
              archived: true,
              ranksFinalised: true,
            },
          }
        );

        console.log(
          `📦 Quiz "${quizName}" archived successfully with ${archivedCount} attempts.`
        );
      } else {
        console.log(
          `ℹ️ Quiz "${quizName}" is already archived.`
        );
      }

    } catch (err) {
      console.error(
        "❌ Rank watcher error:",
        err
      );

      // ----------------------------------------------------------
      // IMPORTANT:
      // Do NOT mark the quiz archived if anything failed.
      //
      // The next watcher cycle will retry.
      // ----------------------------------------------------------
    } finally {
      watcherRunning = false;
    }
  };

  // ------------------------------------------------------------
  // Run immediately
  // ------------------------------------------------------------
  checkQuizLifecycle();

  // ------------------------------------------------------------
  // Check every 30 seconds
  // ------------------------------------------------------------
  watcherInterval = setInterval(
    checkQuizLifecycle,
    30 * 1000
  );

  console.log(
    "👀 Rank/quiz lifecycle watcher started."
  );
}
// ==================== NEW FUNCTIONS ====================

async function disqualifyOverdueAttempts(quizName, quizEndTime) {
  const overdue = await QuizAttempt.find({
    quizName,
    submitted: false,
    startTime: { $exists: true, $ne: null },
  });

  let count = 0;
  for (let a of overdue) {
    const personalEnd = new Date(a.startTime.getTime() + a.durationMinutes * 60000);
    if (personalEnd <= quizEndTime) {
      a.disqualified = true;
      a.score = -1;
      a.totalMarksObtained = -1;
      a.totalTimeMinutes = Math.round(((quizEndTime - a.startTime) / 60000) * 100) / 100;
      a.submitted = true;
      a.endTime = quizEndTime;
      a.rank = -1;
      await a.save();
      count++;
    }
  }
  if (count > 0) console.log(`🚫 Disqualified ${count} overdue unsubmitted attempts.`);
  return count;
}

 async function autoArchiveQuiz(quizName) {
  // ------------------------------------------------------------
  // 1️⃣ FETCH ALL SUBMITTED ATTEMPTS FOR THIS QUIZ
  // ------------------------------------------------------------
  const attempts = await QuizAttempt.find({ submitted: true, quizName }).lean();
  if (attempts.length === 0) {
    console.log(`ℹ️ No submitted attempts to archive for "${quizName}"`);
    return 0;
  }

  // ------------------------------------------------------------
  // 2️⃣ PRESERVE THE CURRENT RESULTS CSV (BEFORE CLEARING)
  // ------------------------------------------------------------
  const csvPath = getCsvPath(quizName);
  if (fs.existsSync(csvPath)) {
    const sanitized = quizName.replace(/[^a-zA-Z0-9-_]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivedCsvPath = path.join(
      resultsDir,
      `archived_results_${sanitized}_${timestamp}.csv`
    );
    fs.copyFileSync(csvPath, archivedCsvPath);
    console.log(`📄 Preserved results CSV → ${archivedCsvPath}`);
  } else {
    console.log(`⚠️ No results CSV found to preserve for "${quizName}"`);
  }

  // ------------------------------------------------------------
  // 3️⃣ FETCH STUDENT DETAILS (NAME, EMAIL) FOR THE ARCHIVE
  // ------------------------------------------------------------
  const regNos = attempts.map(a => a.studentRegNo);
  const students = await Student.find({ regNo: { $in: regNos } }).lean();
  const studentMap = {};
  students.forEach(s => {
    const custom = getCustomDataObject(s.customData);
    studentMap[s.regNo] = {
      name: custom.name || "",
      email: custom.email || ""
    };
  });

  // ------------------------------------------------------------
  // 4️⃣ CREATE ARCHIVED DOCUMENTS
  // ------------------------------------------------------------
  const archivedDocs = attempts.map(a => ({
    ...a,
    studentName: studentMap[a.studentRegNo]?.name || "",
    studentEmail: studentMap[a.studentRegNo]?.email || "",
    archivedAt: new Date(),
  }));

  // ------------------------------------------------------------
  // 5️⃣ SAVE TO ARCHIVED COLLECTION & DELETE FROM ACTIVE
  // ------------------------------------------------------------
  await ArchivedQuizAttempt.insertMany(archivedDocs);
  await QuizAttempt.deleteMany({ quizName });
  console.log(`🗄️ Auto‑archived ${archivedDocs.length} attempts for "${quizName}"`);

  // ------------------------------------------------------------
  // 6️⃣ REBUILD REGISTRATION CSV (STUDENTS REMAIN UNCHANGED)
  // ------------------------------------------------------------
  await rebuildRegistrationCsv(quizName);

  // ------------------------------------------------------------
  // 7️⃣ REBUILD RESULTS CSV – NOW EMPTY (HEADERS ONLY)
  //     This gives a fresh file for the next quiz.
  // ------------------------------------------------------------
  await rebuildCsv(quizName);

  return archivedDocs.length;
}

 async function finalizeRanks() {
  try {
    console.log("⏳ Finalising ranks...");

    const config = await getExamConfig();
    const quizName = config.quizName || "Trivia Quiz";

    const quizEnd = new Date(
      config.startTime.getTime() +
      config.durationMinutes * 60000
    );

    // ------------------------------------------------------------
    // IMPORTANT:
    // Disqualify students who did not submit before the exam ended.
    // ------------------------------------------------------------
    await disqualifyOverdueAttempts(
      quizName,
      quizEnd
    );

    // ------------------------------------------------------------
    // Fetch all submitted, non-disqualified attempts
    // ------------------------------------------------------------
    const attempts = await QuizAttempt.find({
      submitted: true,
      quizName,
      disqualified: false,
    }).lean();

    // ------------------------------------------------------------
    // Calculate ranks
    // ------------------------------------------------------------
    if (attempts.length > 0) {
      const sorted = attempts
        .filter(
          (a) =>
            a.totalMarksObtained !== null &&
            a.totalMarksObtained !== undefined
        )
        .sort((a, b) => {
          // Higher marks first
          if (
            b.totalMarksObtained !==
            a.totalMarksObtained
          ) {
            return (
              b.totalMarksObtained -
              a.totalMarksObtained
            );
          }

          // Lower completion time first
          if (
            a.totalTimeMinutes !==
            b.totalTimeMinutes
          ) {
            return (
              a.totalTimeMinutes -
              b.totalTimeMinutes
            );
          }

          // Earlier submission first
          return (
            (a.endTime?.getTime() || 0) -
            (b.endTime?.getTime() || 0)
          );
        });

      let currentRank = 1;

      for (
        let i = 0;
        i < sorted.length;
        i++
      ) {
        const current = sorted[i];

        // --------------------------------------------------------
        // Same marks + same time + same submission time = tie
        // --------------------------------------------------------
        if (i > 0) {
          const previous = sorted[i - 1];

          const sameMarks =
            current.totalMarksObtained ===
            previous.totalMarksObtained;

          const sameTime =
            current.totalTimeMinutes ===
            previous.totalTimeMinutes;

          const sameEndTime =
            current.endTime?.getTime() ===
            previous.endTime?.getTime();

          if (
            sameMarks &&
            sameTime &&
            sameEndTime
          ) {
            await QuizAttempt.updateOne(
              {
                _id: current._id,
              },
              {
                $set: {
                  rank: previous.rank,
                },
              }
            );

            continue;
          }
        }

        await QuizAttempt.updateOne(
          {
            _id: current._id,
          },
          {
            $set: {
              rank: currentRank,
            },
          }
        );

        currentRank++;
      }
    }

    // ------------------------------------------------------------
    // Disqualified attempts always have rank -1
    // ------------------------------------------------------------
    await QuizAttempt.updateMany(
      {
        submitted: true,
        disqualified: true,
        quizName,
      },
      {
        $set: {
          rank: -1,
        },
      }
    );

    // ------------------------------------------------------------
    // Rebuild results CSV
    // ------------------------------------------------------------
    await rebuildCsv(quizName);

    // ------------------------------------------------------------
    // Mark ranks as finalized
    //
    // IMPORTANT:
    // DO NOT ARCHIVE HERE.
    //
    // finalizeRanks() only calculates/finalizes ranks.
    // ------------------------------------------------------------
    await ExamConfig.updateOne(
      {},
      {
        $set: {
          ranksFinalised: true,
        },
      }
    );

    console.log(
      `✅ Ranks finalised for "${quizName}".`
    );

    // ------------------------------------------------------------
    // IMPORTANT:
    // There is intentionally NO:
    //
    // autoArchiveQuiz()
    //
    // here.
    //
    // Active QuizAttempt records must remain available until
    // the quiz lifecycle is actually finished.
    // ------------------------------------------------------------

  } catch (err) {
    console.error(
      "❌ Finalisation error:",
      err
    );
  }
}

// ============ ROUTES ============

app.get("/admin/config", async (req, res) => {
  try {
    const config = await getExamConfig();
    const regFields = config.registrationFields
      ? Object.fromEntries(config.registrationFields)
      : {};
    res.json({
      success: true,
      config: {
        ...config.toObject(),
        registrationFields: regFields,
        quizName: config.quizName || "Trivia Quiz",
        quizVersion: config.quizVersion || 1,
        archived: config.archived || false,
        // NEW: add this line
        registrationOpen: config.registrationOpen ?? true,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not fetch config" });
  }
});

 app.post("/admin/config", async (req, res) => {
  try {
    const {
      startTime,
      durationMinutes,
      positiveMarks,
      negativeMarks,
      registrationFields,
      quizName,
      isQuizNameChanged,
      registrationOpen,      // <-- NEW
    } = req.body;

    if (!startTime || durationMinutes == null || positiveMarks == null || negativeMarks == null) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    let config = await ExamConfig.findOne();
    if (!config) config = new ExamConfig();

    const oldQuizName = config.quizName || "Trivia Quiz";
    const newQuizName = quizName || "Trivia Quiz";

    // --- Quiz name change handling (unchanged) ---
    if (isQuizNameChanged && oldQuizName !== newQuizName) {
      console.log(`🔄 Quiz name changed from "${oldQuizName}" to "${newQuizName}". Archiving attempts...`);

      let query = { submitted: true };
      if (oldQuizName === "Trivia Quiz") {
        query.$or = [
          { quizName: oldQuizName },
          { quizName: { $in: [null, "", undefined] } }
        ];
      } else {
        query.quizName = oldQuizName;
      }

      const attemptsToArchive = await QuizAttempt.find(query).lean();
      if (attemptsToArchive.length > 0) {
        const regNos = attemptsToArchive.map(a => a.studentRegNo);
        const students = await Student.find({ regNo: { $in: regNos } }).lean();
        const studentMap = {};
        students.forEach(s => {
          const custom = getCustomDataObject(s.customData);
          studentMap[s.regNo] = { name: custom.name || "", email: custom.email || "" };
        });

        const archivedDocs = attemptsToArchive.map(a => ({
          ...a,
          studentName: studentMap[a.studentRegNo]?.name || "",
          studentEmail: studentMap[a.studentRegNo]?.email || "",
          quizName: oldQuizName,
          archivedAt: new Date(),
        }));
        await ArchivedQuizAttempt.insertMany(archivedDocs);
        await QuizAttempt.deleteMany(query);
        console.log(`🗄️ Archived ${attemptsToArchive.length} attempts from "${oldQuizName}" before name change.`);
      }
    }

    // --- Update config fields ---
    config.quizName = newQuizName;
    config.startTime = new Date(startTime);
    config.durationMinutes = parseInt(durationMinutes);
    config.positiveMarks = parseFloat(positiveMarks);
    config.negativeMarks = parseFloat(negativeMarks);
    config.ranksFinalised = false;
    config.archived = false;

    // NEW: save registrationOpen if provided
    if (registrationOpen !== undefined) {
      config.registrationOpen = registrationOpen;
    }

    // --- Registration fields ---
    const map = new Map();
    if (registrationFields) {
      for (const [key, value] of Object.entries(registrationFields)) {
        if (key === 'name' || key === 'email') continue;
        map.set(key, {
          enabled: value.enabled ?? true,
          required: value.required ?? false,
        });
      }
    }
    config.registrationFields = map;
    config.updatedAt = new Date();

    await config.save();

    // --- Rebuild CSVs ---
    await rebuildCsv(newQuizName);
    await rebuildRegistrationCsv(newQuizName);

    startRankWatcher();

    res.json({ success: true, config });
  } catch (err) {
    console.error("Config update error:", err);
    res.status(500).json({ success: false, message: "Update failed" });
  }
});

app.get("/registration-config", async (req, res) => {
  try {
    const config = await getExamConfig();
    const fields = config.registrationFields
      ? Object.fromEntries(config.registrationFields)
      : {};
    res.json({ success: true, registrationFields: fields });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not fetch config" });
  }
});

 app.post("/register", async (req, res) => {
  try {
    const config = await getExamConfig();

    // NEW: Check if registration is open
    if (config.registrationOpen === false) {
      return res.status(403).json({
        success: false,
        message: "Registration is currently closed. Please contact the administrator."
      });
    }

    const extraFields = config.registrationFields ? Object.fromEntries(config.registrationFields) : {};
    const customData = new Map();

    const name = req.body.name;
    const email = req.body.email;
    if (!name || !email) {
      return res.status(400).json({ success: false, message: "Name and email are required." });
    }
    customData.set('name', name);
    customData.set('email', email);

    const missing = [];
    for (const [fieldName, settings] of Object.entries(extraFields)) {
      if (!settings.enabled) continue;
      const value = req.body[fieldName];
      if (settings.required && !value) missing.push(fieldName);
      if (value !== undefined) customData.set(fieldName, value);
    }
    if (missing.length) {
      return res.status(400).json({ success: false, message: `Required: ${missing.join(", ")}` });
    }

    const quizName = config.quizName || "Trivia Quiz";
    const existing = await Student.findOne({
      "customData.email": email,
      "quizName": quizName
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "This email is already registered for the current quiz."
      });
    }

    const regNo = await generateRegNo();
    const student = new Student({ regNo, quizName, customData });
    await student.save();

    await rebuildRegistrationCsv(quizName);

    // ---------- PDF GENERATION (unchanged) ----------
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=reg-${regNo}.pdf`);
    doc.pipe(res);

    const bgPath = path.join(__dirname, "assets", "image.png");
    if (fs.existsSync(bgPath)) {
      doc.image(bgPath, 0, 0, { width: doc.page.width, height: doc.page.height });
    } else {
      doc.rect(0, 0, doc.page.width, doc.page.height).fill("#f8f9fa");
    }

    const pageWidth = doc.page.width;
    const centerX = pageWidth / 2;

    doc.fontSize(28)
       .fillColor("#1a237e")
       .font("Helvetica-Bold")
       .text(quizName, centerX, 80, { align: "center" })
       .moveDown(0.5);

    doc.fontSize(18)
       .fillColor("#303f9f")
       .font("Helvetica")
       .text("Registration Confirmation", centerX, 130, { align: "center" })
       .moveDown(1);

    const cardX = 80;
    const cardY = 180;
    const cardWidth = pageWidth - 160;
    const cardHeight = 280;

    doc.fillColor("#ffffff")
       .fillOpacity(0.85)
       .rect(cardX, cardY, cardWidth, cardHeight)
       .fill()
       .fillOpacity(1)
       .strokeColor("#b0bec5")
       .lineWidth(1)
       .rect(cardX, cardY, cardWidth, cardHeight)
       .stroke();

    let yPos = cardY + 30;
    const leftCol = cardX + 30;
    const rightCol = cardX + 200;

    const detailFontSize = 13;
    const labelColor = "#455a64";
    const valueColor = "#1e293b";

    doc.fontSize(detailFontSize).font("Helvetica-Bold").fillColor(labelColor);
    doc.text("Registration No:", leftCol, yPos);
    doc.font("Helvetica").fillColor(valueColor);
    doc.text(regNo, rightCol, yPos);
    yPos += 30;

    doc.font("Helvetica-Bold").fillColor(labelColor);
    doc.text("Name:", leftCol, yPos);
    doc.font("Helvetica").fillColor(valueColor);
    doc.text(name, rightCol, yPos);
    yPos += 30;

    doc.font("Helvetica-Bold").fillColor(labelColor);
    doc.text("Email:", leftCol, yPos);
    doc.font("Helvetica").fillColor(valueColor);
    doc.text(email, rightCol, yPos);
    yPos += 30;

    for (const [fieldName, settings] of Object.entries(extraFields)) {
      if (!settings.enabled) continue;
      const value = customData.get(fieldName) || "";
      if (value) {
        const label = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
        doc.font("Helvetica-Bold").fillColor(labelColor);
        doc.text(label + ":", leftCol, yPos);
        doc.font("Helvetica").fillColor(valueColor);
        doc.text(value, rightCol, yPos);
        yPos += 30;
      }
    }

    const startIST = config.startTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    doc.font("Helvetica-Bold").fillColor(labelColor);
    doc.text("Quiz Date & Time (IST):", leftCol, yPos);
    doc.font("Helvetica").fillColor(valueColor);
    doc.text(startIST, rightCol, yPos);
    yPos += 30;

    doc.font("Helvetica-Bold").fillColor(labelColor);
    doc.text("Login ID:", leftCol, yPos);
    doc.font("Helvetica").fillColor(valueColor);
    doc.text(regNo, rightCol, yPos);
    yPos += 30;

    doc.font("Helvetica-Bold").fillColor(labelColor);
    doc.text("Password:", leftCol, yPos);
    doc.font("Helvetica").fillColor(valueColor);
    doc.text(email, rightCol, yPos);
    yPos += 30;

    const noteY = cardY + cardHeight + 20;
    doc.strokeColor("#b0bec5")
       .lineWidth(1)
       .moveTo(80, noteY - 5)
       .lineTo(pageWidth - 80, noteY - 5)
       .stroke();

    const rulesY = noteY + 30;
    doc.fontSize(16)
       .fillColor("#1a237e")
       .font("Helvetica-Bold")
       .text("Important Rules", centerX, rulesY, { align: "center" })
       .moveDown(0.5);

    const ruleFontSize = 12;
    const ruleColor = "#37474f";
    const bulletX = 70;
    let rulesYPos = rulesY + 40;

    const rules = [
      "Please login 5 minutes before the exam starts.",
      "Do not press back or refresh the browser during the quiz.",
      "The quiz will start exactly at the mentioned time.",
      "You may navigate between questions freely.",
      "Use the 'Clear Answer' button to deselect your choice.",
      "Submit the quiz manually before the timer ends.",
      "Failure to submit will result in disqualification.",
      "Any malpractice leads to immediate disqualification."
    ];

    doc.fontSize(ruleFontSize)
       .fillColor(ruleColor)
       .font("Helvetica");

    rules.forEach((rule, i) => {
      const y = rulesYPos + i * 22;
      doc.text(`• ${rule}`, bulletX, y, { width: pageWidth - 140 });
    });

    const footerY = doc.page.height - 40;
    doc.fontSize(10)
       .fillColor("#78909c")
       .text("Generated by Trivia Quiz System", centerX, footerY, { align: "center" });

    doc.end();

  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ success: false, message: "Registration failed" });
  }
});
app.get("/questions-csv", async (req, res) => {
  try {
    const config = await getExamConfig();
    const quizName = config.quizName || "Trivia Quiz";
    const questions = await Question.find({ quizName }).sort({ createdAt: 1 }).lean();
    if (questions.length === 0) {
      return res.status(404).json({ success: false, message: "No questions found." });
    }

    const records = questions.map(q => ({
      question: q.question,
      optionA: q.options.A,
      optionB: q.options.B,
      optionC: q.options.C,
      optionD: q.options.D,
      correctAnswer: q.correctAnswer,
      imageUrl: q.imageUrl || "",
      published: q.published ? "Yes" : "No",
      createdAt: q.createdAt ? q.createdAt.toISOString() : "",
    }));

    const csvPath = path.join(resultsDir, `questions_${Date.now()}.csv`);
    const writer = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: "question", title: "Question" },
        { id: "optionA", title: "Option A" },
        { id: "optionB", title: "Option B" },
        { id: "optionC", title: "Option C" },
        { id: "optionD", title: "Option D" },
        { id: "correctAnswer", title: "Correct Answer" },
        { id: "imageUrl", title: "Image URL" },
        { id: "published", title: "Published" },
        { id: "createdAt", title: "Created At" },
      ],
      append: false,
    });
    await writer.writeRecords(records);

    const downloadName = `questions_${new Date().toISOString().slice(0,10)}.csv`;
    res.download(csvPath, downloadName, (err) => {
      if (err) console.error("Download error:", err);
      fs.unlink(csvPath, (unlinkErr) => {
        if (unlinkErr) console.error("Failed to delete temp CSV:", unlinkErr);
      });
    });
  } catch (err) {
    console.error("Questions CSV error:", err);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

 
app.get("/get-questions", async (req, res) => {
  try {
    const config = await getExamConfig();
    const now = new Date();
    if (now < config.startTime) return res.status(403).json({ success: false, message: "Quiz not started" });
    const questions = await Question.find({ published: true, quizName: config.quizName }).sort({ createdAt: 1 });
    res.json({ success: true, questions, positiveMarks: config.positiveMarks, negativeMarks: config.negativeMarks });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

 
 
 
// ============================================================
// QUIZ-SPECIFIC LOGIN
// ============================================================

app.post("/login", async (req, res) => {
  try {
    const {
      regNo,
      email,
    } = req.body;

    if (!regNo || !email) {
      return res.status(400).json({
        success: false,
        message:
          "Registration number and email are required.",
      });
    }

    const student =
      await Student.findOne({
        regNo,
      });

    if (!student) {
      return res.status(404).json({
        success: false,
        message:
          "Invalid registration number.",
      });
    }

    const storedEmail =
      student.customData?.get(
        "email"
      );

    if (
      !storedEmail ||
      storedEmail.toLowerCase() !==
        email.trim().toLowerCase()
    ) {
      return res.status(401).json({
        success: false,
        message:
          "Email does not match our records.",
      });
    }

    const config =
      await getExamConfig();

    const quizName =
      config.quizName ||
      "Trivia Quiz";

    // ------------------------------------------------------------
    // CURRENT QUIZ ATTEMPT
    // ------------------------------------------------------------

    const existingAttempt =
      await QuizAttempt.findOne({
        studentRegNo: regNo,
        quizName,
      }).lean();

    if (
      existingAttempt?.submitted
    ) {
      return res.status(403).json({
        success: false,
        isQuizSubmitted: true,
        message:
          "You have already submitted this quiz.",
      });
    }

    // ------------------------------------------------------------
    // ARCHIVED ATTEMPT
    // ------------------------------------------------------------

    const archivedAttempt =
      await ArchivedQuizAttempt.findOne({
        studentRegNo: regNo,
        quizName,
      }).lean();

    if (archivedAttempt) {
      return res.status(403).json({
        success: false,
        isQuizSubmitted: true,
        message:
          "You have already completed this quiz. Your results are finalized.",
      });
    }

    // ------------------------------------------------------------
    // LOGIN SUCCESS
    // ------------------------------------------------------------

    return res.json({
      success: true,
      isQuizSubmitted: false,

      student: {
        regNo:
          student.regNo,

        customData:
          Object.fromEntries(
            student.customData ||
              new Map()
          ),
      },

      examStartTime:
        config.startTime,

      examDuration:
        config.durationMinutes,

      positiveMarks:
        config.positiveMarks,

      negativeMarks:
        config.negativeMarks,
    });
  } catch (err) {
    console.error(
      "Login error:",
      err
    );

    return res.status(500).json({
      success: false,
      message:
        "Login failed.",
    });
  }
});
 app.post("/start-quiz", async (req, res) => {
  try {
    const { regNo } = req.body;

    if (!regNo) {
      return res.status(400).json({
        success: false,
        message: "Registration number is required.",
      });
    }

    const config = await getExamConfig();
    const quizName = config.quizName || "Trivia Quiz";

    const now = new Date();

    const quizEnd = new Date(
      config.startTime.getTime() +
        config.durationMinutes * 60000
    );

    // Quiz must currently be open.
    if (
      now < config.startTime ||
      now > quizEnd
    ) {
      return res.status(403).json({
        success: false,
        message: "Quiz is not active.",
      });
    }

    // ------------------------------------------------------------
    // BLOCK PREVIOUSLY ARCHIVED SUBMISSION
    // ------------------------------------------------------------

    const archivedAttempt =
      await ArchivedQuizAttempt.findOne({
        studentRegNo: regNo,
        quizName,
      }).lean();

    if (archivedAttempt) {
      return res.status(403).json({
        success: false,
        isQuizSubmitted: true,
        message:
          "You have already submitted this quiz.",
      });
    }

    // ------------------------------------------------------------
    // CHECK EXISTING ACTIVE ATTEMPT
    // ------------------------------------------------------------

    let attempt =
      await QuizAttempt.findOne({
        studentRegNo: regNo,
        quizName,
      });

    if (attempt) {
      // Already submitted -> NEVER allow another attempt.
      if (attempt.submitted) {
        return res.status(403).json({
          success: false,
          isQuizSubmitted: true,
          message:
            "You have already submitted this quiz.",
        });
      }

      // Existing unsubmitted attempt:
      // resume it. DO NOT reset its start time.
      return res.json({
        success: true,
        resumed: true,
        startTime: attempt.startTime,
        durationMinutes:
          attempt.durationMinutes,
        positiveMarks:
          attempt.positiveMarks,
        negativeMarks:
          attempt.negativeMarks,
      });
    }

    // ------------------------------------------------------------
    // VERIFY STUDENT
    // ------------------------------------------------------------

    const student =
      await Student.findOne({ regNo });

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    // ------------------------------------------------------------
    // CREATE FIRST ATTEMPT
    // ------------------------------------------------------------

    attempt = new QuizAttempt({
      studentRegNo: regNo,
      quizName,
      startTime: now,
      durationMinutes:
        config.durationMinutes,
      positiveMarks:
        config.positiveMarks,
      negativeMarks:
        config.negativeMarks,
      answers: [],
      submitted: false,
      disqualified: false,
    });

    await attempt.save();

    return res.json({
      success: true,
      resumed: false,
      startTime: attempt.startTime,
      durationMinutes:
        attempt.durationMinutes,
      positiveMarks:
        attempt.positiveMarks,
      negativeMarks:
        attempt.negativeMarks,
    });
  } catch (err) {
    console.error(
      "Start quiz error:",
      err
    );

    return res.status(500).json({
      success: false,
      message: "Could not start the quiz.",
    });
  }
});
 app.post("/submit-quiz", async (req, res) => {
  try {
    const {
      regNo,
      answers,
      auto,
    } = req.body;

    // ------------------------------------------------------------
    // VALIDATION
    // ------------------------------------------------------------

    if (!regNo) {
      return res.status(400).json({
        success: false,
        message: "Registration number is required.",
      });
    }

    if (!Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        message: "Answers must be an array.",
      });
    }

    const config = await getExamConfig();
    const quizName =
      config.quizName || "Trivia Quiz";

    const now = new Date();

    // ------------------------------------------------------------
    // FIND CURRENT ATTEMPT
    //
    // IMPORTANT:
    // Do NOT trust the frontend `auto` flag for timing.
    // Server time decides whether the attempt expired.
    // ------------------------------------------------------------

    const attempt =
      await QuizAttempt.findOne({
        studentRegNo: regNo,
        quizName,
      });

    if (!attempt) {
      return res.status(404).json({
        success: false,
        message:
          "No quiz attempt found.",
      });
    }

    // ------------------------------------------------------------
    // ALREADY SUBMITTED
    // ------------------------------------------------------------

    if (attempt.submitted) {
      return res.status(409).json({
        success: false,
        alreadySubmitted: true,
        message:
          "This quiz has already been submitted.",
      });
    }

    // ------------------------------------------------------------
    // SERVER-AUTHORITATIVE END TIME
    // ------------------------------------------------------------

    const studentEnd = new Date(
      attempt.startTime.getTime() +
        attempt.durationMinutes * 60000
    );

    const expired =
      now >= studentEnd;

    // `auto` is informational only.
    // Server time determines expiry.
    const disqualified = expired;

    // ------------------------------------------------------------
    // DISQUALIFIED / EXPIRED
    // ------------------------------------------------------------

    if (disqualified) {
      const totalTimeMinutes =
        Math.round(
          ((now.getTime() -
            attempt.startTime.getTime()) /
            60000) *
            100
        ) / 100;

      /*
       * IMPORTANT:
       *
       * Only update if submitted is STILL false.
       *
       * This makes the operation race-safe.
       *
       * If another request submitted first,
       * modifiedCount will be 0.
       */

      const updateResult =
        await QuizAttempt.updateOne(
          {
            _id: attempt._id,
            submitted: false,
          },
          {
            $set: {
              disqualified: true,
              score: -1,
              totalMarksObtained: -1,
              totalTimeMinutes,
              submitted: true,
              endTime: now,
              answers,
              rank: -1,
            },
          }
        );

      // Another submission won the race.
      if (updateResult.modifiedCount !== 1) {
        return res.status(409).json({
          success: false,
          alreadySubmitted: true,
          message:
            "This quiz has already been submitted.",
        });
      }

      // Rebuild only after the database update succeeded.
      await ExamConfig.updateOne(
        {},
        {
          $set: {
            ranksFinalised: false,
            archived: false,
          },
        }
      );

      await rebuildCsv(
        quizName
      );

      await finalizeRanks();

      return res.json({
        success: true,
        disqualified: true,
        score: -1,
        totalMarksObtained: -1,
        message:
          "Time expired. You are disqualified.",
      });
    }

    // ============================================================
    // NORMAL SCORING
    // ============================================================

    const questions =
      await Question.find({
        published: true,
        quizName,
      }).sort({
        createdAt: 1,
      });

    const totalQ =
      questions.length;

    // Do not mutate req.body.answers directly.
    const normalizedAnswers = [
      ...answers,
    ];

    while (
      normalizedAnswers.length <
      totalQ
    ) {
      normalizedAnswers.push(null);
    }

    // Ignore any extra answers beyond actual questions.
    normalizedAnswers.length =
      totalQ;

    let correct = 0;
    let wrong = 0;

    normalizedAnswers.forEach(
      (ans, idx) => {
        if (idx >= questions.length) {
          return;
        }

        if (
          ans ===
          questions[idx].correctAnswer
        ) {
          correct++;
        } else if (
          ans !== null &&
          ans !== undefined &&
          ans !== ""
        ) {
          wrong++;
        }
      }
    );

    const posMarks =
      Number(
        attempt.positiveMarks || 0
      );

    const negMarks =
      Number(
        attempt.negativeMarks || 0
      );

    const maxMarks =
      totalQ * posMarks;

    let netMarks =
      correct * posMarks -
      wrong * negMarks;

    netMarks =
      Math.round(
        netMarks * 100
      ) / 100;

    const totalTimeMinutes =
      Math.round(
        ((now.getTime() -
          attempt.startTime.getTime()) /
          60000) *
          100
      ) / 100;

    // ------------------------------------------------------------
    // ATOMIC SUBMISSION
    // ------------------------------------------------------------

    /*
     * We calculate everything first.
     *
     * Then the actual submission is committed only if:
     *
     *   submitted === false
     *
     * If two requests arrive at the same time,
     * only ONE can change submitted:false -> true.
     */

    const updateResult =
      await QuizAttempt.updateOne(
        {
          _id: attempt._id,
          submitted: false,
        },
        {
          $set: {
            endTime: now,
            totalTimeMinutes,
            answers:
              normalizedAnswers,
            score: correct,
            totalMarksObtained:
              netMarks,
            totalMarks:
              maxMarks,
            submitted: true,
            disqualified: false,
            rank: null,
          },
        }
      );

    // ------------------------------------------------------------
    // RACE LOST
    // ------------------------------------------------------------

    if (
      updateResult.modifiedCount !== 1
    ) {
      return res.status(409).json({
        success: false,
        alreadySubmitted: true,
        message:
          "This quiz has already been submitted.",
      });
    }

    // ------------------------------------------------------------
    // FINALIZE AFTER SUCCESSFUL COMMIT
    // ------------------------------------------------------------

    await ExamConfig.updateOne(
      {},
      {
        $set: {
          ranksFinalised: false,
          archived: false,
        },
      }
    );

    await rebuildCsv(
      quizName
    );

    await finalizeRanks();

    // ------------------------------------------------------------
    // RESPONSE
    // ------------------------------------------------------------

    return res.json({
      success: true,
      score: correct,
      correctCount: correct,
      wrongCount: wrong,
      totalMarksObtained:
        netMarks,
      totalMarks: maxMarks,
      totalQuestions: totalQ,
      totalTimeMinutes,
      disqualified: false,
    });
  } catch (err) {
    console.error(
      "Submit error:",
      err
    );

    return res.status(500).json({
      success: false,
      message:
        "Submission failed. Please try again.",
    });
  }
});
app.post("/finalize-ranks", async (req, res) => {
  try {
    await finalizeRanks();
    res.json({ success: true, message: "Ranks finalised manually." });
  } catch (err) {
    console.error("Finalise ranks error:", err);
    res.status(500).json({ success: false, message: "Rank finalisation failed" });
  }
});

app.post("/admin/archive-and-clear", async (req, res) => {
  try {
    // 1. Re‑rank first (this also updates the CSV)
    await finalizeRanks();

    // 2. Now archive (finalizeRanks already did auto‑archiving, but if you need manual control)
    const config = await getExamConfig();
    const quizName = config.quizName || "Trivia Quiz";

    // Check if any attempts left (finalizeRanks may have archived them already)
    const attempts = await QuizAttempt.find({ submitted: true, quizName }).lean();
    if (attempts.length === 0) {
      return res.status(400).json({ success: false, message: "No attempts to archive." });
    }

    const regNos = attempts.map(a => a.studentRegNo);
    const students = await Student.find({ regNo: { $in: regNos } }).lean();
    const studentMap = {};
    students.forEach(s => {
      const custom = getCustomDataObject(s.customData);
      studentMap[s.regNo] = { name: custom.name || "", email: custom.email || "" };
    });

    const archivedDocs = attempts.map(a => ({
      ...a,
      studentName: studentMap[a.studentRegNo]?.name || "",
      studentEmail: studentMap[a.studentRegNo]?.email || "",
      archivedAt: new Date(),
    }));
    await ArchivedQuizAttempt.insertMany(archivedDocs);
    await QuizAttempt.deleteMany({ quizName });
    console.log(`🗄️ Archived ${attempts.length} attempts for "${quizName}" and cleared.`);

    await ExamConfig.updateOne({}, { $set: { ranksFinalised: true, archived: true } });
    await rebuildCsv(quizName);
    await rebuildRegistrationCsv(quizName);

    res.json({
      success: true,
      message: `Archived ${attempts.length} attempts for "${quizName}", cleared QuizAttempt, and reset CSVs.`,
    });
  } catch (err) {
    console.error("Archive error:", err);
    res.status(500).json({ success: false, message: "Archive failed." });
  }
});
app.post("/admin/re-rank-archived/:quizName", async (req, res) => {
  try {
    const { quizName } = req.params;
    const attempts = await ArchivedQuizAttempt.find({ quizName }).lean();
    if (attempts.length === 0) {
      return res.status(404).json({ success: false, message: "No archived attempts." });
    }

    // Sort by marks desc, time asc, endTime asc (tie‑breaker)
    const sorted = attempts
      .filter(a => a.totalMarksObtained !== null && a.totalMarksObtained !== undefined)
      .sort((a, b) => {
        if (b.totalMarksObtained !== a.totalMarksObtained)
          return b.totalMarksObtained - a.totalMarksObtained;
        if (a.totalTimeMinutes !== b.totalTimeMinutes)
          return a.totalTimeMinutes - b.totalTimeMinutes;
        return (a.endTime?.getTime() || 0) - (b.endTime?.getTime() || 0);
      });

    let rank = 1;
    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i];
      if (i > 0) {
        const prev = sorted[i - 1];
        if (current.totalMarksObtained === prev.totalMarksObtained &&
            current.totalTimeMinutes === prev.totalTimeMinutes &&
            current.endTime?.getTime() === prev.endTime?.getTime()) {
          // same rank
          await ArchivedQuizAttempt.updateOne({ _id: current._id }, { $set: { rank: prev.rank } });
          continue;
        }
      }
      await ArchivedQuizAttempt.updateOne({ _id: current._id }, { $set: { rank: rank } });
      rank++;
    }

    res.json({ success: true, message: `Re‑ranked ${sorted.length} archived attempts for "${quizName}".` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});
app.delete("/admin/archived-quizzes/:quizName", async (req, res) => {
  try {
    const { quizName } = req.params;
    const result = await ArchivedQuizAttempt.deleteMany({ quizName });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "No archived attempts found for this quiz." });
    }

    const sanitized = quizName.replace(/[^a-zA-Z0-9-_]/g, "_");
    const patterns = [
      `archived_results_${sanitized}.csv`,
      `archived_registrations_${sanitized}.csv`,
      `archived_questions_${sanitized}.csv`
    ];
    patterns.forEach(file => {
      const filePath = path.join(resultsDir, file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Deleted archived CSV: ${filePath}`);
      }
    });

    res.json({
      success: true,
      message: `Deleted archived quiz "${quizName}" (${result.deletedCount} attempts).`
    });
  } catch (err) {
    console.error("Delete archived quiz error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/admin/archived-quizzes", async (req, res) => {
  try {
    const archivedAttemptsAgg = await ArchivedQuizAttempt.aggregate([
      {
        $group: {
          _id: "$quizName",
          startTime: { $min: "$startTime" },
          endTime: { $max: "$endTime" },
          durationMinutes: { $avg: "$durationMinutes" },
          attemptsCount: { $sum: 1 },
        },
      },
      {
        $project: {
          quizName: "$_id",
          startTime: 1,
          endTime: 1,
          durationMinutes: { $round: ["$durationMinutes", 0] },
          attemptsCount: 1,
          _id: 0,
        },
      },
    ]);

    const questionAgg = await Question.aggregate([
      {
        $group: {
          _id: {
            $cond: {
              if: { $or: [{ $eq: ["$quizName", null] }, { $eq: ["$quizName", ""] }, { $eq: ["$quizName", undefined] }] },
              then: "Trivia Quiz",
              else: "$quizName"
            }
          },
          questionsCount: { $sum: 1 },
        },
      },
      {
        $project: {
          quizName: "$_id",
          questionsCount: 1,
          _id: 0,
        },
      },
    ]);

    const studentAgg = await Student.aggregate([
      {
        $group: {
          _id: {
            $cond: {
              if: { $or: [{ $eq: ["$quizName", null] }, { $eq: ["$quizName", ""] }, { $eq: ["$quizName", undefined] }] },
              then: "Trivia Quiz",
              else: "$quizName"
            }
          },
          studentsCount: { $sum: 1 },
        },
      },
      {
        $project: {
          quizName: "$_id",
          studentsCount: 1,
          _id: 0,
        },
      },
    ]);

    const quizMap = new Map();

    archivedAttemptsAgg.forEach(item => {
      const key = item.quizName || "Trivia Quiz";
      quizMap.set(key, {
        quizName: key,
        startTime: item.startTime,
        endTime: item.endTime,
        durationMinutes: item.durationMinutes || 0,
        attemptsCount: item.attemptsCount,
        questionsCount: 0,
        studentsCount: 0,
      });
    });

    questionAgg.forEach(item => {
      const key = item.quizName || "Trivia Quiz";
      if (quizMap.has(key)) {
        quizMap.get(key).questionsCount = item.questionsCount;
      }
    });

    studentAgg.forEach(item => {
      const key = item.quizName || "Trivia Quiz";
      if (quizMap.has(key)) {
        quizMap.get(key).studentsCount = item.studentsCount;
      }
    });

    const quizzes = Array.from(quizMap.values())
      .filter(q => q.quizName && q.quizName.trim() !== "")
      .filter(q => q.attemptsCount > 0)
      .sort((a, b) => {
        if (a.startTime && b.startTime) return new Date(b.startTime) - new Date(a.startTime);
        if (a.startTime) return -1;
        if (b.startTime) return 1;
        return a.quizName.localeCompare(b.quizName);
      });

    res.json({ success: true, quizzes });
  } catch (err) {
    console.error("Archived quizzes error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/admin/archived-csv/:quizName", async (req, res) => {
  try {
    const { quizName } = req.params;
    const attempts = await ArchivedQuizAttempt.find({ quizName }).lean();
    if (!attempts.length) {
      return res.status(404).json({ success: false, message: "No archived attempts for this quiz." });
    }

    // Build records without rank
    const records = attempts.map(a => ({
      regNo: a.studentRegNo,
      name: a.studentName || "",
      email: a.studentEmail || "",
      correctCount: a.score || 0,
      wrongCount: (a.answers || []).filter((ans, idx) => ans !== null && ans !== "?").length - (a.score || 0),
      totalMarksObtained: a.totalMarksObtained || 0,
      totalMarks: a.totalMarks || 0,
      totalTimeMinutes: a.totalTimeMinutes || 0,
      rank: null,
      submissionTime: a.endTime ? a.endTime.toISOString() : "",
      disqualified: a.disqualified ? "YES" : "NO",
      endTime: a.endTime,
    }));

    // Separate disqualified
    const disqualifiedRecords = records.filter(r => r.disqualified === "YES");
    const activeRecords = records.filter(r => r.disqualified === "NO");

    // Sort active by marks desc, time asc, endTime asc (tie‑breaker)
    activeRecords.sort((a, b) => {
      if (b.totalMarksObtained !== a.totalMarksObtained)
        return b.totalMarksObtained - a.totalMarksObtained;
      if (a.totalTimeMinutes !== b.totalTimeMinutes)
        return a.totalTimeMinutes - b.totalTimeMinutes;
      return (a.endTime?.getTime() || 0) - (b.endTime?.getTime() || 0);
    });

    // Assign ranks (dense ranking)
    let currentRank = 1;
    for (let i = 0; i < activeRecords.length; i++) {
      const curr = activeRecords[i];
      if (i > 0) {
        const prev = activeRecords[i - 1];
        if (curr.totalMarksObtained === prev.totalMarksObtained &&
            curr.totalTimeMinutes === prev.totalTimeMinutes) {
          curr.rank = prev.rank;
          continue;
        }
      }
      curr.rank = currentRank;
      currentRank++;
    }

    // Disqualified get -1
    disqualifiedRecords.forEach(r => r.rank = -1);

    const finalRecords = [...activeRecords, ...disqualifiedRecords];

    const csvPath = path.join(resultsDir, `archived_results_${quizName.replace(/[^a-zA-Z0-9-_]/g, "_")}.csv`);
    const writer = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: "regNo", title: "RegNo" },
        { id: "name", title: "Name" },
        { id: "email", title: "Email" },
        { id: "correctCount", title: "Correct" },
        { id: "wrongCount", title: "Wrong" },
        { id: "totalMarksObtained", title: "MarksObtained" },
        { id: "totalMarks", title: "TotalMarks" },
        { id: "totalTimeMinutes", title: "TimeMinutes" },
        { id: "rank", title: "Rank" },
        { id: "submissionTime", title: "SubmissionTime" },
        { id: "disqualified", title: "Disqualified" },
      ],
      append: false,
    });
    await writer.writeRecords(finalRecords);

    const downloadName = `archived_results_${quizName.replace(/[^a-zA-Z0-9-_]/g, "_")}.csv`;
    res.download(csvPath, downloadName, (err) => {
      if (err) console.error("Download error:", err);
      fs.unlink(csvPath, (unlinkErr) => {
        if (unlinkErr) console.error("Failed to delete temp CSV:", unlinkErr);
      });
    });
  } catch (err) {
    console.error("Archived results CSV error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/admin/archived-registrations-csv/:quizName", async (req, res) => {
  try {
    const { quizName } = req.params;
    let query = { quizName: quizName };
    if (quizName === "Trivia Quiz") {
      query = { $or: [{ quizName: quizName }, { quizName: { $in: [null, "", undefined] } }] };
    }
    const students = await Student.find(query).sort({ registeredAt: 1 }).lean();

    if (!students.length) {
      return res.status(404).json({ success: false, message: "No registrations found for this quiz." });
    }

    const allCustomKeys = new Set();
    students.forEach(s => {
      const data = getCustomDataMap(s.customData);
      data.forEach((_, key) => allCustomKeys.add(key));
    });
    allCustomKeys.add('name');
    allCustomKeys.add('email');
    const sortedKeys = Array.from(allCustomKeys).sort();

    const header = [
      { id: "regNo", title: "RegNo" },
      { id: "registeredAt", title: "Registration Time" },
    ];
    sortedKeys.forEach(key => {
      header.push({ id: key, title: key.charAt(0).toUpperCase() + key.slice(1) });
    });

    const records = students.map(s => {
      const data = getCustomDataMap(s.customData);
      const record = {
        regNo: s.regNo,
        registeredAt: s.registeredAt.toISOString(),
      };
      sortedKeys.forEach(key => {
        record[key] = data.get(key) || "";
      });
      return record;
    });

    const csvPath = path.join(resultsDir, `archived_registrations_${quizName.replace(/[^a-zA-Z0-9-_]/g, "_")}.csv`);
    const writer = createObjectCsvWriter({
      path: csvPath,
      header,
      append: false,
    });
    await writer.writeRecords(records);

    const downloadName = `archived_registrations_${quizName.replace(/[^a-zA-Z0-9-_]/g, "_")}.csv`;
    res.download(csvPath, downloadName, (err) => {
      if (err) console.error("Download error:", err);
      fs.unlink(csvPath, (unlinkErr) => {
        if (unlinkErr) console.error("Failed to delete temp CSV:", unlinkErr);
      });
    });
  } catch (err) {
    console.error("Archived registrations CSV error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/admin/archived-questions-csv/:quizName", async (req, res) => {
  try {
    const { quizName } = req.params;
    let query = { quizName: quizName };
    if (quizName === "Trivia Quiz") {
      query = { $or: [{ quizName: quizName }, { quizName: { $in: [null, "", undefined] } }] };
    }
    const questions = await Question.find(query).sort({ createdAt: 1 }).lean();
    if (!questions.length) {
      return res.status(404).json({ success: false, message: "No questions found for this quiz." });
    }

    const records = questions.map(q => ({
      question: q.question,
      optionA: q.options.A,
      optionB: q.options.B,
      optionC: q.options.C,
      optionD: q.options.D,
      correctAnswer: q.correctAnswer,
      imageUrl: q.imageUrl || "",
      published: q.published ? "Yes" : "No",
      createdAt: q.createdAt ? q.createdAt.toISOString() : "",
    }));

    const csvPath = path.join(resultsDir, `archived_questions_${quizName.replace(/[^a-zA-Z0-9-_]/g, "_")}.csv`);
    const writer = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: "question", title: "Question" },
        { id: "optionA", title: "Option A" },
        { id: "optionB", title: "Option B" },
        { id: "optionC", title: "Option C" },
        { id: "optionD", title: "Option D" },
        { id: "correctAnswer", title: "Correct Answer" },
        { id: "imageUrl", title: "Image URL" },
        { id: "published", title: "Published" },
        { id: "createdAt", title: "Created At" },
      ],
      append: false,
    });
    await writer.writeRecords(records);

    const downloadName = `archived_questions_${quizName.replace(/[^a-zA-Z0-9-_]/g, "_")}.csv`;
    res.download(csvPath, downloadName, (err) => {
      if (err) console.error("Download error:", err);
      fs.unlink(csvPath, (unlinkErr) => {
        if (unlinkErr) console.error("Failed to delete temp CSV:", unlinkErr);
      });
    });
  } catch (err) {
    console.error("Archived questions CSV error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/admin/reset-config', async (req, res) => {
  res.json({ success: true, message: 'Config reset locally.' });
});

app.post("/admin/reset-exam", async (req, res) => {
  try {
    let config = await ExamConfig.findOne();

    if (!config) {
      config = new ExamConfig({
        quizName: "Trivia Quiz",
        startTime: new Date(Date.now() + 5 * 60000),
        durationMinutes: 30,
        positiveMarks: 1,
        negativeMarks: 0,
        registrationFields: new Map(),
        quizVersion: 1,
      });

      await config.save();
    }

    const oldQuizName =
      config.quizName || "Trivia Quiz";

    console.log(
      `🔄 Resetting exam for quiz: "${oldQuizName}"`
    );

    // ============================================================
    // 1. FIND ALL CURRENT REGISTRATIONS
    // ============================================================

    let studentQuery = {
      quizName: oldQuizName,
    };

    // Trivia Quiz historically may have registrations
    // with null/empty quizName.
    if (oldQuizName === "Trivia Quiz") {
      studentQuery = {
        $or: [
          { quizName: oldQuizName },
          { quizName: null },
          { quizName: "" },
        ],
      };
    }

    const studentsToArchive =
      await Student.find(studentQuery).lean();

    console.log(
      `📋 Found ${studentsToArchive.length} registered students.`
    );

    // ============================================================
    // 2. ARCHIVE ALL REGISTRATIONS
    // ============================================================

    if (studentsToArchive.length > 0) {
      const archivedRegistrations =
        studentsToArchive.map((student) => ({
          regNo: student.regNo,

          quizName: oldQuizName,

          registeredAt:
            student.registeredAt ||
            student.createdAt ||
            new Date(),

          customData:
            student.customData || {},

          archivedAt: new Date(),
        }));

      // Remove duplicates if reset somehow gets called twice.
      // We only want one archived registration per quiz/regNo.
      await ArchivedQuizRegistration.deleteMany({
        quizName: oldQuizName,
        regNo: {
          $in: archivedRegistrations.map(
            (s) => s.regNo
          ),
        },
      });

      await ArchivedQuizRegistration.insertMany(
        archivedRegistrations
      );

      console.log(
        `📦 Archived ${archivedRegistrations.length} registrations for "${oldQuizName}".`
      );
    }

    // ============================================================
    // 3. FIND SUBMITTED ATTEMPTS
    // ============================================================

    let attemptQuery = {
      submitted: true,
    };

    if (oldQuizName === "Trivia Quiz") {
      attemptQuery.$or = [
        { quizName: oldQuizName },
        { quizName: null },
        { quizName: "" },
      ];
    } else {
      attemptQuery.quizName =
        oldQuizName;
    }

    const attemptsToArchive =
      await QuizAttempt.find(
        attemptQuery
      ).lean();

    console.log(
      `📝 Found ${attemptsToArchive.length} submitted attempts.`
    );

    // ============================================================
    // 4. ARCHIVE SUBMITTED ATTEMPTS
    // ============================================================

    if (attemptsToArchive.length > 0) {
      const regNos =
        attemptsToArchive
          .map(
            (a) => a.studentRegNo
          )
          .filter(Boolean);

      const students =
        await Student.find({
          regNo: {
            $in: regNos,
          },
        }).lean();

      const studentMap = {};

      students.forEach((s) => {
        const custom =
          getCustomDataObject(
            s.customData
          );

        studentMap[s.regNo] = {
          name:
            custom.name || "",
          email:
            custom.email || "",
        };
      });

      const archivedDocs =
        attemptsToArchive.map(
          (attempt) => ({
            ...attempt,

            studentName:
              studentMap[
                attempt.studentRegNo
              ]?.name || "",

            studentEmail:
              studentMap[
                attempt.studentRegNo
              ]?.email || "",

            quizName:
              oldQuizName,

            archivedAt:
              new Date(),
          })
        );

      await ArchivedQuizAttempt.insertMany(
        archivedDocs
      );

      // Remove the submitted attempts
      await QuizAttempt.deleteMany(
        attemptQuery
      );

      console.log(
        `📦 Archived ${attemptsToArchive.length} submitted attempts.`
      );
    }

    // ============================================================
    // 5. DELETE OLD CURRENT REGISTRATIONS
    // ============================================================

    if (studentsToArchive.length > 0) {
      await Student.deleteMany(
        studentQuery
      );

      console.log(
        `🗑️ Deleted ${studentsToArchive.length} old registrations from Student.`
      );
    }

    // ============================================================
    // 6. START NEW QUIZ VERSION
    // ============================================================

    const newVersion =
      (config.quizVersion || 1) + 1;

    config.quizVersion =
      newVersion;

    await Counter.findOneAndUpdate(
      {
        _id: `regNo_${newVersion}`,
      },
      {
        $set: {
          seq: 0,
        },
      },
      {
        upsert: true,
      }
    );

    const now = new Date();

    const newStart =
      new Date(
        now.getTime() +
          5 * 60000
      );

    config.startTime =
      newStart;

    config.ranksFinalised =
      false;

    config.archived =
      false;

    config.durationMinutes =
      30;

    config.positiveMarks =
      1;

    config.negativeMarks =
      0;

    // Optional new quiz name
    if (req.body?.quizName) {
      config.quizName =
        req.body.quizName;
    }

    await config.save();

    // ============================================================
    // 7. REBUILD CSVs FOR NEW QUIZ
    // ============================================================

    await rebuildCsv(
      config.quizName
    );

    await rebuildRegistrationCsv(
      config.quizName
    );

    startRankWatcher();

    // ============================================================
    // 8. RESPONSE
    // ============================================================

    const submittedCount =
      attemptsToArchive.length;

    const notSubmittedCount =
      studentsToArchive.length -
      new Set(
        attemptsToArchive.map(
          (a) =>
            String(
              a.studentRegNo || ""
            )
        )
      ).size;

    res.json({
      success: true,

      message:
        `Exam reset successfully. ` +
        `New version: ${newVersion}. ` +
        `Archived ${studentsToArchive.length} registrations, ` +
        `${submittedCount} submitted attempts, ` +
        `${notSubmittedCount} not-submitted registrations.`,

      startTime:
        newStart,

      quizVersion:
        newVersion,

      archivedRegistrations:
        studentsToArchive.length,

      archivedSubmitted:
        submittedCount,

      archivedNotSubmitted:
        notSubmittedCount,
    });
  } catch (err) {
    console.error(
      "❌ Reset exam error:",
      err
    );

    res.status(500).json({
      success: false,
      message:
        err.message ||
        "Failed to reset exam.",
    });
  }
});

app.post("/admin/publish-questions", async (req, res) => {
  try {
    const config = await getExamConfig();
    const now = new Date();
    if (now >= config.startTime) {
      return res.status(403).json({
        success: false,
        message: "Quiz has already started. You cannot publish questions now."
      });
    }
    const count = await Question.countDocuments({ quizName: config.quizName });
    if (count === 0) {
      return res.status(400).json({
        success: false,
        message: "No questions to publish. Add at least one question first."
      });
    }
    const result = await Question.updateMany({ quizName: config.quizName }, { $set: { published: true } });
    res.json({
      success: true,
      message: `✅ Successfully published ${result.modifiedCount} questions.`,
      count: result.modifiedCount,
    });
  } catch (err) {
    console.error("Publish error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/admin/disqualified-csv", async (req, res) => {
  try {
    const config = await getExamConfig();
    const quizName = config.quizName || "Trivia Quiz";

    const disqualifiedAttempts = await QuizAttempt.find({
      quizName,
      disqualified: true,
      submitted: true,
    }).lean();

    if (disqualifiedAttempts.length === 0) {
      return res.status(404).json({ success: false, message: "No disqualified students." });
    }

    const regNos = disqualifiedAttempts.map(a => a.studentRegNo);
    const students = await Student.find({ regNo: { $in: regNos } }).lean();
    const studentMap = {};
    students.forEach(s => {
      studentMap[s.regNo] = getCustomDataObject(s.customData);
    });

    const records = disqualifiedAttempts.map(a => {
      const custom = studentMap[a.studentRegNo] || {};
      return {
        regNo: a.studentRegNo,
        name: custom.name || "",
        email: custom.email || "",
        submittedAt: a.endTime ? a.endTime.toISOString() : "",
        totalTimeMinutes: a.totalTimeMinutes || 0,
      };
    });

    const fileName = `disqualified_${quizName.replace(/[^a-zA-Z0-9-_]/g, "_")}.csv`;
    const csvPath = path.join(resultsDir, fileName);

    const writer = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: "regNo", title: "Registration No." },
        { id: "name", title: "Name" },
        { id: "email", title: "Email" },
        { id: "submittedAt", title: "Submission Time" },
        { id: "totalTimeMinutes", title: "Time Taken (mins)" },
      ],
      append: false,
    });

    await writer.writeRecords(records);

    const downloadName = `disqualified_${quizName.replace(/[^a-zA-Z0-9-_]/g, "_")}.csv`;
    res.download(csvPath, downloadName);
  } catch (err) {
    console.error("Disqualified CSV error:", err);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

app.get("/admin/list-csvs", async (req, res) => {
  try {
    const files = fs.readdirSync(resultsDir);
    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/admin/reload-watcher", async (req, res) => {
  try {
    startRankWatcher();
    const config = await getExamConfig();
    res.json({
      success: true,
      message: "Watcher reloaded",
      startTime: config.startTime,
      endTime: new Date(config.startTime.getTime() + config.durationMinutes * 60000),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/my-rank", async (req, res) => {
  try {
    const { regNo } = req.query;
    if (!regNo) return res.status(400).json({ success: false, message: "Missing regNo" });

    const attempt = await QuizAttempt.findOne({ studentRegNo: regNo, submitted: true });
    if (!attempt) return res.status(404).json({ success: false, message: "No submission found" });

    res.json({ success: true, rank: attempt.rank, disqualified: attempt.disqualified });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/debug-attempt/:regNo", async (req, res) => {
  try {
    const attempt = await QuizAttempt.findOne({ studentRegNo: req.params.regNo });
    if (!attempt) return res.status(404).json({ success: false, message: "No attempt found" });
    res.json(attempt);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/finalize-quiz", async (req, res) => {
  try {
    const now = new Date();
    const config = await getExamConfig();
    const quizName = config.quizName || "Trivia Quiz";
    const overdue = await QuizAttempt.find({ submitted: false, startTime: { $exists: true }, quizName });
    let finalized = 0;

    for (let a of overdue) {
      const end = new Date(a.startTime.getTime() + a.durationMinutes * 60000);
      if (now > end) {
        a.disqualified = true;
        a.score = -1;
        a.totalMarksObtained = -1;
        a.totalTimeMinutes = Math.round(((end - a.startTime) / 60000) * 100) / 100;
        a.submitted = true;
        a.endTime = end;
        a.rank = -1;
        await a.save();
        finalized++;
      }
    }

    if (finalized > 0) {
      await ExamConfig.updateOne({}, { $set: { ranksFinalised: false, archived: false } });
      await rebuildCsv(quizName);
      await finalizeRanks();
    }

    res.json({ success: true, message: `${finalized} overdue attempts finalized` });
  } catch (err) {
    console.error("Finalization error:", err);
    res.status(500).json({ success: false, message: "Finalization failed" });
  }
});

app.get("/results-csv", async (req, res) => {
  try {
    const config = await getExamConfig();
    const quizName = config.quizName || "Trivia Quiz";
    const now = new Date();
    const quizEnd = new Date(config.startTime.getTime() + config.durationMinutes * 60000);

    // ------------------------------------------------------------
    // 🚀 If the quiz has ended and ranks are NOT finalised,
    //    run finalizeRanks() NOW to auto-submit disqualified candidates.
    // ------------------------------------------------------------
    if (now >= quizEnd && !config.ranksFinalised) {
      console.log(`⏳ Quiz ended, finalising ranks before serving CSV...`);
      await finalizeRanks();
      // Reload config to get updated flag
      const updatedConfig = await getExamConfig();
      if (!updatedConfig.ranksFinalised) {
        console.warn("⚠️ Ranks still not finalised after manual finalize attempt.");
      }
    }

    // ------------------------------------------------------------
    // Now check if the live CSV exists and has data
    // ------------------------------------------------------------
    const filePath = getCsvPath(quizName);

    if (!fs.existsSync(filePath)) {
      // If live CSV missing, try to serve archived
      const archivedCount = await ArchivedQuizAttempt.countDocuments({ quizName });
      if (archivedCount > 0) {
        return res.redirect(`/admin/archived-csv/${encodeURIComponent(quizName)}`);
      }
      return res.status(404).json({ success: false, message: "No results available." });
    }

    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(line => line.trim() !== "");
    if (lines.length <= 1) {
      // Live CSV is empty (only headers) – check archived
      const archivedCount = await ArchivedQuizAttempt.countDocuments({ quizName });
      if (archivedCount > 0) {
        return res.redirect(`/admin/archived-csv/${encodeURIComponent(quizName)}`);
      }
      return res.status(404).json({ success: false, message: "No results data (only headers)." });
    }

    // ------------------------------------------------------------
    // Serve the live CSV
    // ------------------------------------------------------------
    const downloadName = `results_${quizName.replace(/[^a-zA-Z0-9-_]/g, "_")}.csv`;
    res.download(filePath, downloadName);

  } catch (err) {
    console.error("❌ Results CSV error:", err);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});
app.get("/admin/archived-not-submitted-csv/:quizName", async (req, res) => {
  try {
    const quizName = decodeURIComponent(req.params.quizName);

    // 1️⃣ Find all archived registrations for this quiz
    let regQuery = { quizName };
    // For legacy "Trivia Quiz" registrations may have null/empty
    if (quizName === "Trivia Quiz") {
      regQuery = {
        $or: [
          { quizName: "Trivia Quiz" },
          { quizName: { $in: [null, "", undefined] } },
        ],
      };
    }
    const registrations = await ArchivedQuizRegistration.find(regQuery)
      .sort({ registeredAt: 1 })
      .lean();

    if (registrations.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No archived registrations found for "${quizName}".`,
      });
    }

    // 2️⃣ Find all archived submitted attempts for this quiz
    let attemptQuery = {};
    if (quizName === "Trivia Quiz") {
      attemptQuery.$or = [
        { quizName: "Trivia Quiz" },
        { quizName: { $in: [null, "", undefined] } },
      ];
    } else {
      attemptQuery.quizName = quizName;
    }
    const submittedAttempts = await ArchivedQuizAttempt.find(attemptQuery)
      .select("studentRegNo")
      .lean();

    const submittedRegNos = new Set(
      submittedAttempts
        .map((a) => String(a.studentRegNo).trim().toLowerCase())
        .filter(Boolean)
    );

    // 3️⃣ Filter registrations that are NOT in the submitted set
    const notSubmitted = registrations.filter((reg) => {
      const regNo = String(reg.regNo).trim().toLowerCase();
      return regNo && !submittedRegNos.has(regNo);
    });

    if (notSubmitted.length === 0) {
      return res.status(404).json({
        success: false,
        message: "All registered students submitted this quiz.",
      });
    }

    // 4️⃣ Build CSV with custom fields from registration
    const allCustomKeys = new Set();
    notSubmitted.forEach((reg) => {
      const data = getCustomDataMap(reg.customData);
      data.forEach((_, key) => allCustomKeys.add(key));
    });
    allCustomKeys.add("name");
    allCustomKeys.add("email");
    const sortedKeys = Array.from(allCustomKeys).sort();

    const header = [
      { id: "regNo", title: "RegNo" },
      { id: "registeredAt", title: "Registration Time" },
    ];
    sortedKeys.forEach((key) => {
      header.push({
        id: key,
        title: key.charAt(0).toUpperCase() + key.slice(1),
      });
    });

    const records = notSubmitted.map((reg) => {
      const data = getCustomDataMap(reg.customData);
      const record = {
        regNo: reg.regNo,
        registeredAt: reg.registeredAt ? reg.registeredAt.toISOString() : "",
      };
      sortedKeys.forEach((key) => {
        record[key] = data.get(key) || "";
      });
      return record;
    });

    // 5️⃣ Generate CSV
    const safeQuizName = quizName.replace(/[^a-zA-Z0-9-_]/g, "_");
    const csvPath = path.join(
      resultsDir,
      `archived_not_submitted_${safeQuizName}.csv`
    );

    const writer = createObjectCsvWriter({
      path: csvPath,
      header,
      append: false,
    });
    await writer.writeRecords(records);

    const downloadName = `archived_not_submitted_${safeQuizName}.csv`;
    res.download(csvPath, downloadName, (err) => {
      if (err) console.error("CSV download error:", err);
      fs.unlink(csvPath, (unlinkErr) => {
        if (unlinkErr) console.error("Failed to delete temp CSV:", unlinkErr);
      });
    });
  } catch (err) {
    console.error("❌ Archived not-submitted CSV error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
});
app.get("/admin/not-submitted-live-csv", async (req, res) => {
  try {
    const config = await getExamConfig();
    const quizName = config.quizName || "Trivia Quiz";

    // 1️⃣ Find all students registered for this quiz
    let studentQuery = { quizName };
    if (quizName === "Trivia Quiz") {
      studentQuery = {
        $or: [
          { quizName: "Trivia Quiz" },
          { quizName: { $in: [null, "", undefined] } },
        ],
      };
    }
    const students = await Student.find(studentQuery).lean();

    if (students.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No registered students found for this quiz.",
      });
    }

    // 2️⃣ Find all students who have a submitted attempt (including disqualified)
    const submittedAttempts = await QuizAttempt.find({
      quizName,
      submitted: true,
    })
      .select("studentRegNo")
      .lean();

    const submittedRegNos = new Set(
      submittedAttempts
        .map((a) => String(a.studentRegNo).trim().toLowerCase())
        .filter(Boolean)
    );

    // 3️⃣ Filter those who do NOT have a submitted attempt
    const notSubmitted = students.filter((s) => {
      const regNo = String(s.regNo).trim().toLowerCase();
      return regNo && !submittedRegNos.has(regNo);
    });

    if (notSubmitted.length === 0) {
      return res.status(404).json({
        success: false,
        message: "All registered students have submitted the quiz.",
      });
    }

    // 4️⃣ Build CSV with custom fields
    const allCustomKeys = new Set();
    notSubmitted.forEach((s) => {
      const data = getCustomDataMap(s.customData);
      data.forEach((_, key) => allCustomKeys.add(key));
    });
    allCustomKeys.add("name");
    allCustomKeys.add("email");
    const sortedKeys = Array.from(allCustomKeys).sort();

    const header = [
      { id: "regNo", title: "RegNo" },
      { id: "registeredAt", title: "Registration Time" },
    ];
    sortedKeys.forEach((key) => {
      header.push({
        id: key,
        title: key.charAt(0).toUpperCase() + key.slice(1),
      });
    });

    const records = notSubmitted.map((s) => {
      const data = getCustomDataMap(s.customData);
      const record = {
        regNo: s.regNo,
        registeredAt: s.registeredAt.toISOString(),
      };
      sortedKeys.forEach((key) => {
        record[key] = data.get(key) || "";
      });
      return record;
    });

    // 5️⃣ Generate and send CSV
    const safeQuizName = quizName.replace(/[^a-zA-Z0-9-_]/g, "_");
    const csvPath = path.join(
      resultsDir,
      `not_submitted_live_${safeQuizName}.csv`
    );

    const writer = createObjectCsvWriter({
      path: csvPath,
      header,
      append: false,
    });
    await writer.writeRecords(records);

    const downloadName = `not_submitted_live_${safeQuizName}.csv`;
    res.download(csvPath, downloadName, (err) => {
      if (err) console.error("CSV download error:", err);
      fs.unlink(csvPath, (unlinkErr) => {
        if (unlinkErr) console.error("Failed to delete temp CSV:", unlinkErr);
      });
    });
  } catch (err) {
    console.error("❌ Not-submitted live CSV error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
});

app.get("/registrations-csv", async (req, res) => {
  try {
    const config = await getExamConfig();
    const quizName = config.quizName || "Trivia Quiz";
    const filePath = getRegistrationCsvPath(quizName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: "No registrations yet for this quiz" });
    }
    const downloadName = `registrations_${quizName.replace(/[^a-zA-Z0-9-_]/g, "_")}.csv`;
    res.download(filePath, downloadName);
  } catch (err) {
    console.error("Download registration CSV error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/available-results", async (req, res) => {
  try {
    const files = fs.readdirSync(resultsDir);
    const csvFiles = files.filter(f => f.startsWith("results_") && f.endsWith(".csv"));
    res.json({ success: true, files: csvFiles });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete("/admin/clear-csv", async (req, res) => {
  try {
    const config = await getExamConfig();
    const quizName = config.quizName || "Trivia Quiz";
    deleteCsvByQuizName(quizName);
    const regCsv = getRegistrationCsvPath(quizName);
    if (fs.existsSync(regCsv)) fs.unlinkSync(regCsv);
    await rebuildCsv(quizName);
    await rebuildRegistrationCsv(quizName);
    res.json({ success: true, message: `Current quiz CSVs cleared for "${quizName}"` });
  } catch (err) {
    console.error("Clear CSV error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/servertime", async (req, res) => {
  const config = await getExamConfig();
  const now = new Date();
  const quizEnd = new Date(config.startTime.getTime() + config.durationMinutes * 60000);
  res.json({
    serverTimeUTC: now.toISOString(),
    serverTimeIST: now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    QUIZ_START_IST: config.startTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    QUIZ_END_UTC: quizEnd.toISOString(),
    isQuizOpen: now >= config.startTime && now <= quizEnd,
    durationMinutes: config.durationMinutes,
    positiveMarks: config.positiveMarks,
    negativeMarks: config.negativeMarks,
    ranksFinalised: config.ranksFinalised,
    archived: config.archived || false,
  });
});

app.get("/quiz-status", async (req, res) => {
  try {
    const config =
      await getExamConfig();

    const now = new Date();

    const quizEnd =
      new Date(
        config.startTime.getTime() +
          config.durationMinutes *
            60000
      );

    const isOpen =
      now >= config.startTime &&
      now < quizEnd;

    const hasEnded =
      now >= quizEnd;

    return res.json({
      success: true,

      // Server timestamp.
      serverNow: now,

      isQuizOpen: isOpen,
      hasEnded,

      startTime:
        config.startTime,

      endTime:
        quizEnd,

      durationMinutes:
        config.durationMinutes,

      quizName:
        config.quizName ||
        "Trivia Quiz",

      ranksFinalised:
        config.ranksFinalised,

      archived:
        config.archived || false,
    });
  } catch (err) {
    console.error(
      "Quiz status error:",
      err
    );

    return res.status(500).json({
      success: false,
      message:
        "Could not get quiz status.",
    });
  }
});
// ============ CRUD ROUTES FOR QUESTIONS ============
 app.get("/questions", async (req, res) => {
  try {
    const config = await getExamConfig();

    const quizName =
      config.quizName || "Trivia Quiz";

    let query;

    if (quizName === "Trivia Quiz") {
      query = {
        $or: [
          { quizName: "Trivia Quiz" },
          { quizName: null },
          { quizName: "" },
        ],
      };
    } else {
      query = {
        quizName,
      };
    }

    const questions = await Question.find(query)
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      questions,
      quizName,
    });
  } catch (err) {
    console.error(
      "Get questions error:",
      err
    );

    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});
app.post("/post-question", upload.single("image"), async (req, res) => {
  try {
    let { question, options, correctAnswer } = req.body;
    if (typeof options === "string") {
      try { options = JSON.parse(options); } catch (e) {
        return res.status(400).json({ success: false, message: "Invalid options format" });
      }
    }
    if (!question || !options?.A || !options?.B || !options?.C || !options?.D || !correctAnswer) {
      return res.status(400).json({ success: false, message: "Incomplete MCQ data" });
    }
    const config = await getExamConfig();
    const quizName = config.quizName || "Trivia Quiz";
    let imageUrl = "";
    if (req.file) {
      imageUrl = `/uploads/${req.file.filename}`;
    } else if (req.body.imageUrl) {
      imageUrl = req.body.imageUrl;
    }
    const newQuestion = new Question({
      question, options, correctAnswer, imageUrl,
      published: false,
      quizName
    });
    await newQuestion.save();
    res.status(201).json({ success: true, message: "MCQ saved as draft" });
  } catch (err) {
    console.error("Post question error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.put("/update-question/:id", upload.single("image"), async (req, res) => {
  try {
    let { question, options, correctAnswer, imageUrl } = req.body;
    if (typeof options === "string") {
      try { options = JSON.parse(options); } catch (e) {
        return res.status(400).json({ success: false, message: "Invalid options format" });
      }
    }
    const config = await getExamConfig();
    const quizName = config.quizName || "Trivia Quiz";
    const updateData = { question, options, correctAnswer, quizName };
    if (req.file) {
      updateData.imageUrl = `/uploads/${req.file.filename}`;
    } else if (imageUrl !== undefined) {
      updateData.imageUrl = imageUrl;
    }
    const updated = await Question.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json({ success: true, question: updated });
  } catch (err) {
    console.error("Update question error:", err);
    res.status(500).json({ success: false, message: "Update failed" });
  }
});
app.get(
  "/admin/archived-not-submitted-csv/:quizName",
  async (req, res) => {
    try {
      const quizName = decodeURIComponent(
        req.params.quizName
      );

      console.log(
        `📋 Not-submitted CSV requested for: "${quizName}"`
      );

      // --------------------------------------------------
      // 1. Find archived registrations
      // --------------------------------------------------

      const registrations =
        await ArchivedQuizRegistration.find({
          quizName,
        })
          .sort({ registeredAt: 1 })
          .lean();

      console.log(
        `📋 Archived registrations: ${registrations.length}`
      );

      if (registrations.length === 0) {
        return res.status(404).json({
          success: false,
          message:
            `No archived registrations found for "${quizName}". ` +
            `Make sure the NEW reset-exam route was used.`,
        });
      }

      // --------------------------------------------------
      // 2. Find submitted attempts
      // --------------------------------------------------

      const submittedAttempts =
        await ArchivedQuizAttempt.find({
          quizName,
        })
          .select("studentRegNo")
          .lean();

      console.log(
        `📝 Archived submitted attempts: ${submittedAttempts.length}`
      );

      // --------------------------------------------------
      // 3. Build submitted registration-number Set
      // --------------------------------------------------

      const submittedRegNos = new Set(
        submittedAttempts
          .map((attempt) =>
            String(
              attempt.studentRegNo || ""
            )
              .trim()
              .toLowerCase()
          )
          .filter(Boolean)
      );

      // --------------------------------------------------
      // 4. Registered but NOT submitted
      // --------------------------------------------------

      const notSubmitted =
        registrations.filter((student) => {
          const regNo = String(
            student.regNo || ""
          )
            .trim()
            .toLowerCase();

          return (
            regNo &&
            !submittedRegNos.has(regNo)
          );
        });

      console.log(
        `⏳ Not submitted: ${notSubmitted.length}`
      );

      // --------------------------------------------------
      // 5. Convert customData
      // --------------------------------------------------

      const getCustomValue = (
        customData,
        key
      ) => {
        if (!customData) {
          return "";
        }

        if (
          customData instanceof Map
        ) {
          return (
            customData.get(key) || ""
          );
        }

        return (
          customData[key] || ""
        );
      };

      // --------------------------------------------------
      // 6. Prepare CSV records
      // --------------------------------------------------

      const records =
        notSubmitted.map((student) => ({
          regNo:
            student.regNo || "",

          name:
            getCustomValue(
              student.customData,
              "name"
            ),

          email:
            getCustomValue(
              student.customData,
              "email"
            ),

          registeredAt:
            student.registeredAt
              ? new Date(
                  student.registeredAt
                ).toLocaleString(
                  "en-IN",
                  {
                    timeZone:
                      "Asia/Kolkata",
                  }
                )
              : "",
        }));

      // --------------------------------------------------
      // 7. Create CSV
      // --------------------------------------------------

      const safeQuizName =
        quizName.replace(
          /[^a-zA-Z0-9-_]/g,
          "_"
        );

      const csvPath = path.join(
        resultsDir,
        `archived_not_submitted_${safeQuizName}.csv`
      );

      const writer =
        createObjectCsvWriter({
          path: csvPath,

          header: [
            {
              id: "regNo",
              title: "RegNo",
            },
            {
              id: "name",
              title: "Name",
            },
            {
              id: "email",
              title: "Email",
            },
            {
              id: "registeredAt",
              title: "Registration Time",
            },
          ],

          append: false,
        });

      await writer.writeRecords(
        records
      );

      // --------------------------------------------------
      // 8. Download CSV
      // --------------------------------------------------

      const downloadName =
        `archived_not_submitted_${safeQuizName}.csv`;

      res.download(
        csvPath,
        downloadName,
        (err) => {
          if (err) {
            console.error(
              "❌ CSV download error:",
              err
            );
          }

          fs.unlink(
            csvPath,
            (unlinkErr) => {
              if (unlinkErr) {
                console.error(
                  "❌ Failed to remove temp CSV:",
                  unlinkErr
                );
              }
            }
          );
        }
      );
    } catch (err) {
      console.error(
        "❌ Not-submitted CSV error:",
        err
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to generate not-submitted CSV.",
        error: err.message,
      });
    }
  }
);
app.delete("/delete-question/:id", async (req, res) => {
  try {
    await Question.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Question deleted" });
  } catch (err) {
    console.error("Delete question error:", err);
    res.status(500).json({ success: false, message: "Delete failed" });
  }
});

// --------------- START SERVER ---------------
startRankWatcher();
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  getExamConfig().then((c) =>
    console.log(`⏰ Quiz start (UTC): ${c.startTime.toISOString()}`)
  );
});

