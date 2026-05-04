const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())

const JWT_SECRET = process.env.JWT_SECRET

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('MongoDB connected'))
.catch(err => console.log(err))

const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  password: String,
  createdAt: { type: Date, default: Date.now }
})

const projectSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  userEmail: String,
  projectName: String,
  branch: String,
  language: String,
  code: String,
  status: String,
  runAt: { type: Date, default: Date.now },
  duration: Number,
  logs: String,
  output: String,
  errorOutput: String
})

const User = mongoose.model('User', userSchema)
const Project = mongoose.model('Project', projectSchema)

function auth(req,res,next){
  const token = req.headers['authorization']
  if(!token) return res.status(401).json({message:'No token'})
  try{
    const decoded = jwt.verify(token, JWT_SECRET)
    req.user = decoded
    next()
  }catch{
    res.status(401).json({message:'Invalid token'})
  }
}

app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});

app.post('/api/signup', async (req,res)=>{
  const {name,email,password} = req.body
  if(!name || !email || !password) return res.status(400).json({message:'All fields required'})

  const exist = await User.findOne({email})
  if(exist) return res.status(400).json({message:'Email exists'})

  const hash = await bcrypt.hash(password,10)
  const user = await User.create({name,email,password:hash})

  const token = jwt.sign({id:user._id,email:user.email,name:user.name},JWT_SECRET)

  res.json({token,user})
})

app.post('/api/login', async (req,res)=>{
  const {email,password} = req.body
  if(!email || !password) return res.status(400).json({message:'Required'})

  const user = await User.findOne({email})
  if(!user) return res.status(401).json({message:'Invalid'})

  const match = await bcrypt.compare(password,user.password)
  if(!match) return res.status(401).json({message:'Invalid'})

  const token = jwt.sign({id:user._id,email:user.email,name:user.name},JWT_SECRET)

  res.json({token,user})
})

app.get('/api/projects', auth, async (req,res)=>{
  const data = await Project.find({userId:req.user.id}).sort({runAt:-1})
  res.json(data)
})

app.post('/api/projects/run', auth, async (req,res)=>{
  const {projectName,branch,code,language} = req.body

  const project = await Project.create({
    userId:req.user.id,
    userEmail:req.user.email,
    projectName,
    branch,
    language,
    code,
    status:'success',
    duration:1,
    logs:'Executed',
    output:'Done'
  })

  res.json({project})
})

app.get('/api/stats', auth, async (req,res)=>{
  const data = await Project.find({userId:req.user.id})
  res.json({
    total:data.length,
    success:data.filter(x=>x.status==='success').length,
    failed:data.filter(x=>x.status==='failed').length,
    running:data.filter(x=>x.status==='running').length
  })
})

const PORT = process.env.PORT || 4000
app.listen(PORT,()=>console.log('Server running on '+PORT))