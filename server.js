const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const JWT_SECRET = 'cicd_secret_key_2024';

mongoose.connect('mongodb://localhost:27017/cicd_dashboard', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(function() {
  console.log('Connected to MongoDB Compass (local)');
}).catch(function(err) {
  console.log('MongoDB connection error:', err.message);
});

var userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

var projectSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userEmail: { type: String, required: true },
  projectName: { type: String, required: true },
  branch: { type: String, default: 'main' },
  language: { type: String, default: 'unknown' },
  code: { type: String, default: '' },
  status: { type: String, enum: ['success', 'failed', 'running', 'pending'], default: 'pending' },
  runAt: { type: Date, default: Date.now },
  duration: { type: Number, default: 0 },
  logs: { type: String, default: '' },
  output: { type: String, default: '' },
  errorOutput: { type: String, default: '' }
});

var User = mongoose.model('User', userSchema);
var Project = mongoose.model('Project', projectSchema);

function authMiddleware(req, res, next) {
  var token = req.headers['authorization'];
  if (!token) return res.status(401).json({ message: 'No token provided' });
  try {
    var decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
}

function detectLanguage(code) {
  code = code.trim();
  if (code.includes('def ') && (code.includes('print(') || code.includes('import '))) return 'python';
  if (code.includes('public static void main') || code.includes('System.out.println')) return 'java';
  if (code.includes('#include') && (code.includes('cout') || code.includes('printf'))) return 'c';
  if (code.includes('package main') && code.includes('fmt.')) return 'go';
  if (code.includes('puts ') || (code.includes('def ') && code.includes('end'))) return 'ruby';
  if (code.includes('<?php') || code.includes('echo ')) return 'php';
  if (code.includes('console.log') || code.includes('const ') || code.includes('let ') || code.includes('function ')) return 'javascript';
  return 'javascript';
}

function getLangConfig(language) {
  var configs = {
    python: { ext: '.py', cmd: 'python3' },
    javascript: { ext: '.js', cmd: 'node' },
    java: { ext: '.java', cmd: null },
    c: { ext: '.c', cmd: null },
    go: { ext: '.go', cmd: 'go run' },
    ruby: { ext: '.rb', cmd: 'ruby' },
    php: { ext: '.php', cmd: 'php' }
  };
  return configs[language] || configs['javascript'];
}

function runCode(code, language) {
  return new Promise(function(resolve) {
    var startTime = Date.now();
    var config = getLangConfig(language);
    var tmpDir = os.tmpdir();
    var uniqueId = Date.now();
    var fileName = 'cicd_' + uniqueId + config.ext;
    var filePath = path.join(tmpDir, fileName);
    var command = '';

    if (language === 'java') {
      var javaFile = path.join(tmpDir, 'Main_' + uniqueId + '.java');
      var javaCode = code.replace(/public\s+class\s+\w+/, 'public class Main_' + uniqueId);
      fs.writeFileSync(javaFile, javaCode);
      command = 'javac ' + javaFile + ' -d ' + tmpDir + ' && java -cp ' + tmpDir + ' Main_' + uniqueId;
    } else if (language === 'c') {
      fs.writeFileSync(filePath, code);
      var outFile = path.join(tmpDir, 'cicd_out_' + uniqueId);
      command = 'gcc ' + filePath + ' -o ' + outFile + ' && ' + outFile;
    } else {
      fs.writeFileSync(filePath, code);
      command = config.cmd + ' ' + filePath;
    }

    exec(command, { timeout: 15000, cwd: tmpDir }, function(error, stdout, stderr) {
      var duration = ((Date.now() - startTime) / 1000).toFixed(2);
      try { fs.unlinkSync(filePath); } catch (e) {}
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: error ? (error.code || 1) : 0,
        duration: parseFloat(duration),
        timedOut: error && error.killed
      });
    });
  });
}

function buildLogs(projectName, language, result) {
  var t = new Date().toLocaleTimeString();
  var logs = '';
  logs += '[' + t + '] [INFO] Pipeline started: ' + projectName + '\n';
  logs += '[' + t + '] [INFO] Language: ' + language.toUpperCase() + '\n';
  logs += '[' + t + '] [INFO] Writing code to temp file...\n';
  logs += '[' + t + '] [INFO] Running ' + language + ' executor...\n';
  logs += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

  if (result.timedOut) {
    logs += '[ERROR] Execution timed out after 15 seconds\n';
  } else {
    if (result.stdout) {
      logs += 'PROGRAM OUTPUT:\n' + result.stdout + '\n';
    } else {
      logs += 'PROGRAM OUTPUT: (no output)\n';
    }
    if (result.stderr) {
      logs += '\nERROR / STDERR:\n' + result.stderr + '\n';
    }
  }

  logs += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

  if (result.timedOut) {
    logs += '[FAILED] Pipeline failed — code timed out (15s limit)\n';
  } else if (result.exitCode === 0) {
    logs += '[OK] Exit code: 0 — execution successful\n';
    logs += '[OK] Duration: ' + result.duration + 's\n';
    logs += '[OK] Pipeline completed successfully!\n';
  } else {
    logs += '[ERROR] Exit code: ' + result.exitCode + ' — execution failed\n';
    logs += '[FAILED] Pipeline failed — check errors above and fix your code\n';
  }

  return logs;
}

// ─── AUTH ROUTES ─────────────────────────────────────

app.post('/api/signup', async function(req, res) {
  var name = req.body.name;
  var email = req.body.email;
  var password = req.body.password;

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'All fields are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  }

  var existing = await User.findOne({ email: email });
  if (existing) {
    return res.status(400).json({ message: 'Email already registered' });
  }

  var hashed = await bcrypt.hash(password, 10);
  var user = new User({ name: name, email: email, password: hashed });
  await user.save();

  var token = jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ message: 'Signup successful', token: token, user: { id: user._id, name: user.name, email: user.email } });
});

app.post('/api/login', async function(req, res) {
  var email = req.body.email;
  var password = req.body.password;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  var user = await User.findOne({ email: email });
  if (!user) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  var match = await bcrypt.compare(password, user.password);
  if (!match) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  var token = jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ message: 'Login successful', token: token, user: { id: user._id, name: user.name, email: user.email } });
});

// ─── PROJECT ROUTES ───────────────────────────────────

app.get('/api/users', authMiddleware, async function(req, res) {
  var users = await User.find({}, { password: 0 });
  res.json(users);
});

app.get('/api/projects', authMiddleware, async function(req, res) {
  var projects = await Project.find({ userId: req.user.id }).sort({ runAt: -1 });
  res.json(projects);
});

app.post('/api/projects/run', authMiddleware, async function(req, res) {
  var projectName = req.body.projectName;
  var branch = req.body.branch || 'main';
  var code = req.body.code || '';
  var language = req.body.language || detectLanguage(code);

  if (!projectName) {
    return res.status(400).json({ message: 'Project name is required' });
  }
  if (!code.trim()) {
    return res.status(400).json({ message: 'Please paste your code before running' });
  }

  var project = new Project({
    userId: req.user.id,
    userEmail: req.user.email,
    projectName: projectName,
    branch: branch,
    language: language,
    code: code,
    status: 'running',
    runAt: new Date(),
    logs: '[INFO] Pipeline starting...\n'
  });
  await project.save();

  runCode(code, language).then(async function(result) {
    var logs = buildLogs(projectName, language, result);
    var status = (result.exitCode === 0 && !result.timedOut) ? 'success' : 'failed';
    await Project.findByIdAndUpdate(project._id, {
      status: status,
      duration: result.duration,
      logs: logs,
      output: result.stdout,
      errorOutput: result.stderr
    });
  }).catch(async function(err) {
    await Project.findByIdAndUpdate(project._id, {
      status: 'failed',
      logs: '[ERROR] Internal error: ' + err.message + '\n[FAILED] Pipeline failed\n',
      duration: 0
    });
  });

  res.json({ message: 'Pipeline started', project: project });
});

app.get('/api/projects/:id', authMiddleware, async function(req, res) {
  var project = await Project.findOne({ _id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ message: 'Project not found' });
  res.json(project);
});

app.get('/api/stats', authMiddleware, async function(req, res) {
  var projects = await Project.find({ userId: req.user.id });
  var total = projects.length;
  var success = projects.filter(function(p) { return p.status === 'success'; }).length;
  var failed = projects.filter(function(p) { return p.status === 'failed'; }).length;
  var running = projects.filter(function(p) { return p.status === 'running'; }).length;
  res.json({ total: total, success: success, failed: failed, running: running });
});

var PORT = 4000;

app.listen(PORT, function() {
  console.log('Backend running on http://localhost:' + PORT);
});
