import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { LayoutDashboard, GitBranch, MessageSquare, Cpu, Settings2, Zap, CheckCircle2, Clock, AlertCircle, Play, RefreshCw, Thermometer, Activity, Database, Code2, Star, X, Send, Terminal, BarChart2, Flame, ExternalLink, ChevronRight, Copy, Check, ToggleLeft, ToggleRight, Save, History, Plus, Search } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid, LineChart, Line } from 'recharts'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import Aurora from './components/Aurora/Aurora'
import SpotlightCard from './components/SpotlightCard/SpotlightCard'
import GradientText from './components/GradientText/GradientText'
import ShinyText from './components/ShinyText/ShinyText'
import BlurText from './components/BlurText/BlurText'
import CountUp from './components/CountUp/CountUp'
import AnimatedContent from './components/AnimatedContent/AnimatedContent'
import './App.css'

const API = ''
async function apiFetch(path) {
  try { const r = await fetch(API + path); if (!r.ok) return null; return r.json() }
  catch { return null }
}

function Badge({ status }) {
  const m = {
    done:'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
    completed:'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
    in_progress:'bg-blue-500/15 text-blue-300 border-blue-500/25',
    running:'bg-blue-500/15 text-blue-300 border-blue-500/25',
    pending:'bg-zinc-700/40 text-zinc-400 border-zinc-600/30',
    failed:'bg-red-500/15 text-red-300 border-red-500/25',
    active:'bg-violet-500/15 text-violet-300 border-violet-500/25',
  }
  const pulse = (status==='in_progress'||status==='running') ? ' animate-pulse' : ''
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${m[status]||m.pending}${pulse}`}>{status?.replace('_',' ')}</span>
}

function Ring({ pct, size=44, stroke=3, color='#7c3aed' }) {
  const r=(size-stroke*2)/2, circ=2*Math.PI*r, dash=circ*(pct/100)
  return (
    <svg width={size} height={size} style={{transform:'rotate(-90deg)'}}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        style={{transition:'stroke-dasharray 0.8s cubic-bezier(0.4,0,0.2,1)'}}/>
    </svg>
  )
}

function ProgBar({ val, max, color='#7c3aed' }) {
  const pct = max>0 ? Math.min(100,(val/max)*100) : 0
  return (
    <div className="w-full h-1.5 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.05)'}}>
      <div className="h-full rounded-full" style={{width:`${pct}%`,background:`linear-gradient(90deg,${color}99,${color})`,transition:'width 0.7s ease'}}/>
    </div>
  )
}

const NAV = [
  {id:'overview', Icon:LayoutDashboard, label:'Overview'},
  {id:'pipeline', Icon:GitBranch,       label:'Pipeline'},
  {id:'chat',     Icon:MessageSquare,   label:'Chat'},
  {id:'sessions', Icon:History,         label:'Sessions'},
  {id:'models',   Icon:Cpu,            label:'Models'},
  {id:'settings', Icon:Settings2,      label:'Settings'},
]

function useGpu(interval=4000) {
  const [gpu,setGpu]=useState(null)
  useEffect(()=>{
    const load=()=>apiFetch('/system/gpu').then(d=>{ if(d) setGpu(d) })
    load(); const iv=setInterval(load,interval); return()=>clearInterval(iv)
  },[interval])
  return gpu
}

function GpuBar({ used, total, color='#7c3aed' }) {
  const pct = total>0 ? Math.min(100,(used/total)*100) : 0
  const heat = pct>85?'#ef4444':pct>65?'#d97706':color
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.06)'}}>
        <div className="h-full rounded-full transition-all duration-700" style={{width:`${pct}%`,background:`linear-gradient(90deg,${heat}99,${heat})`}}/>
      </div>
      <span className="text-[10px] tabular-nums" style={{color:heat,minWidth:'2.8rem',textAlign:'right'}}>{used}/{total}MB</span>
    </div>
  )
}

function detectLang(title='', result='') {
  if (/\.py|python/i.test(title)) return 'python'
  if (/\.ts|typescript/i.test(title)) return 'typescript'
  if (/\.rs|rust/i.test(title)) return 'rust'
  if (/\.go\b/i.test(title)) return 'go'
  if (/\.sh|bash/i.test(title)) return 'bash'
  if (/\.css/i.test(title)) return 'css'
  if (/\.html/i.test(title)) return 'html'
  if (/import|export|const |function |class /i.test(result)) return 'javascript'
  return 'javascript'
}

function TaskModal({ taskId, onClose }) {
  const [task,setTask]=useState(null)
  const [loading,setLoading]=useState(true)
  useEffect(()=>{
    apiFetch(`/task/${taskId}`).then(d=>{ setTask(d); setLoading(false) })
  },[taskId])
  useEffect(()=>{
    const handler=(e)=>{ if(e.key==='Escape') onClose() }
    window.addEventListener('keydown',handler); return()=>window.removeEventListener('keydown',handler)
  },[onClose])
  const scoreColor=s=>s>=8?'#10b981':s>=6?'#d97706':'#ef4444'
  // pipeline_log is stored as a JSON string in the DB — parse it
  const plog=useMemo(()=>{
    if(!task?.pipeline_log) return null
    if(typeof task.pipeline_log==='object') return task.pipeline_log
    try{ return JSON.parse(task.pipeline_log) }catch{ return null }
  },[task])
  // Build a clean agent summary from the parsed log
  const agentSummary=useMemo(()=>{
    if(!plog) return []
    const agents=[]
    if(plog.research&&plog.research!=='skipped') agents.push({name:'Research',icon:'🔍',status:'done',detail:String(plog.research).slice(0,80)})
    else if(plog.research==='skipped') agents.push({name:'Research',icon:'🔍',status:'skipped',detail:'Skipped'})
    if(plog.architect) agents.push({name:'Architect',icon:'🏗',status:'done',detail:String(plog.architect).slice(0,80)})
    if(plog.coderScore!=null) agents.push({name:'Coder',icon:'💻',status:'done',detail:`Score: ${plog.coderScore}/10 · ${plog.coderRounds||1} round(s)`})
    if(plog.refactored!=null) agents.push({name:'Refactor',icon:'🔧',status:plog.refactored?'done':'skipped',detail:plog.refactored?'Refactored':'Not refactored'})
    if(plog.testsPassed!=null) agents.push({name:'Tester',icon:'🧪',status:plog.testsPassed?'done':'warn',detail:plog.testsPassed?'Tests passed':'Tests failed'})
    if(plog.reviewScore!=null) agents.push({name:'Reviewer',icon:'👁',status:'done',detail:`Score: ${plog.reviewScore}/10`})
    if(plog.archReview) agents.push({name:'Arch-Review',icon:'📐',status:'done',detail:String(plog.archReview?.output||'').slice(0,80)})
    if(plog.secScore!=null) agents.push({name:'Security',icon:'🔒',status:plog.secScore>=7?'done':'warn',detail:`Score: ${plog.secScore}/10`})
    if(plog.writtenFile) agents.push({name:'Docs',icon:'📄',status:'done',detail:plog.writtenFile})
    if(plog.recovery?.triggered) agents.push({name:'Recovery',icon:'🚑',status:'warn',detail:'Recovery triggered'})
    return agents
  },[plog])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{backdropFilter:'blur(12px)',background:'rgba(0,0,0,0.7)'}} onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl overflow-hidden" style={{background:'rgba(9,9,11,0.97)',border:'1px solid rgba(255,255,255,0.1)',boxShadow:'0 24px 80px rgba(0,0,0,0.8)'}}>
        <div className="flex items-start justify-between px-5 py-4 border-b" style={{borderColor:'rgba(255,255,255,0.07)'}}>
          <div className="flex-1 min-w-0 pr-4">
            {loading ? <div className="h-4 w-48 bg-white/5 rounded animate-pulse"/> :
              <h2 className="text-sm font-semibold text-white leading-snug">{task?.title}</h2>}
            {task && (
              <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                {task.quality_score!=null && <span className="text-sm font-bold" style={{color:scoreColor(task.quality_score)}}>{task.quality_score}/10</span>}
                {task.duration_ms && <span className="text-[11px] text-zinc-500">{(task.duration_ms/1000).toFixed(1)}s</span>}
                {task.model_used && <span className="text-[11px] text-zinc-600">{task.model_used}</span>}
                <Badge status={task.status}/>
              </div>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 transition-all text-zinc-500 hover:text-white flex-shrink-0"><X size={15}/></button>
        </div>
        <div className="flex-1 overflow-y-auto forge-scroll">
          {loading ? (
            <div className="p-5 space-y-3">{[...Array(4)].map((_,i)=><div key={i} className="h-3 bg-white/5 rounded animate-pulse" style={{width:`${70+i*8}%`}}/>)}</div>
          ) : task?.result ? (
            <div>
              <div className="px-5 py-3 border-b flex items-center gap-2" style={{borderColor:'rgba(255,255,255,0.06)'}}>
                <Code2 size={12} className="text-zinc-500"/>
                <span className="text-xs text-zinc-500 font-medium">Generated Code</span>
              </div>
              <SyntaxHighlighter
                language={detectLang(task.title,task.result)}
                style={oneDark}
                customStyle={{margin:0,padding:'1.25rem',background:'transparent',fontSize:'0.7rem',lineHeight:'1.6'}}
                showLineNumbers={true}
                lineNumberStyle={{color:'rgba(255,255,255,0.15)',fontSize:'0.65rem',paddingRight:'1rem'}}
              >{task.result}</SyntaxHighlighter>
              {/* Agent team summary — shows every agent that ran and their outcome */}
              {agentSummary.length>0 && (
                <div className="px-5 py-4 border-t" style={{borderColor:'rgba(255,255,255,0.06)'}}>
                  <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">🤖 {agentSummary.length}-Agent Team That Ran</p>
                  <div className="grid grid-cols-2 gap-2">
                    {agentSummary.map((a)=>{
                      const c=a.status==='done'?'#10b981':a.status==='warn'?'#f59e0b':'#52525b'
                      return (
                        <div key={a.name} className="px-3 py-2 rounded-lg flex items-start gap-2" style={{background:'rgba(255,255,255,0.025)',border:`1px solid ${c}22`}}>
                          <span className="text-sm mt-0.5 flex-shrink-0">{a.icon}</span>
                          <div className="min-w-0">
                            <p className="text-[10px] font-semibold mb-0.5" style={{color:c}}>{a.name}</p>
                            <p className="text-[10px] text-zinc-500 line-clamp-2">{a.detail}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  {plog?.sessionBestScore!=null && (
                    <div className="mt-3 px-3 py-2 rounded-lg flex items-center gap-2" style={{background:'rgba(16,185,129,0.06)',border:'1px solid rgba(16,185,129,0.15)'}}>
                      <span className="text-xs">🏆</span>
                      <span className="text-xs text-emerald-400">Session best: <strong>{plog.sessionBestScore}/10</strong></span>
                      {plog.durationMs && <span className="text-xs text-zinc-600 ml-auto">{(plog.durationMs/1000).toFixed(1)}s total</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="p-5 text-sm text-zinc-600">No code result saved for this task.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function ActivityFeed() {
  const [events,setEvents]=useState([])
  useEffect(()=>{
    const es=new EventSource('/events')
    es.onmessage=(e)=>{
      try{
        const d=JSON.parse(e.data)
        if(d.event==='task_start'||d.event==='pipeline_stage'||d.event==='agent'||d.event==='task_complete'||d.event==='epic_review_tasks'){
          setEvents(prev=>[{...d,ts:Date.now()},...prev].slice(0,40))
        }
      }catch{}
    }
    return()=>es.close()
  },[])
  if(!events.length) return null
  return (
    <div className="fixed bottom-4 right-4 w-72 z-40 pointer-events-none">
      <div className="space-y-1.5">
        {events.slice(0,5).map((ev,i)=>(
          <div key={ev.ts+i} className="px-3 py-2 rounded-xl text-[11px] pointer-events-auto animate-in fade-in"
            style={{background:'rgba(9,9,11,0.92)',border:'1px solid rgba(255,255,255,0.08)',backdropFilter:'blur(12px)',opacity:1-i*0.18}}>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{background:ev.event==='task_complete'?'#10b981':ev.event==='task_start'?'#3b82f6':'#7c3aed'}}/>
              <span className="text-zinc-400 flex-1 truncate">
                {ev.event==='task_start'&&`Running: ${ev.title||ev.taskId||''}`}
                {ev.event==='pipeline_stage'&&`Stage: ${ev.role} ${ev.status}`}
                {ev.event==='agent'&&`${ev.agent}: ${ev.status}`}
                {ev.event==='task_complete'&&`Done: ${ev.title||''} (${ev.score||'?'}/10)`}
                {ev.event==='epic_review_tasks'&&`Epic review: +${ev.added} fix tasks`}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Sidebar({ tab, setTab, projects, running }) {
  const [activeModel, setActiveModel] = React.useState(null)
  const [ctxUsed, setCtxUsed] = React.useState(0) // tokens used in current session (approx)

  useEffect(()=>{
    const poll=async()=>{
      // Get loaded model from Ollama ps
      try {
        const ps = await fetch('http://localhost:11434/api/ps').then(r=>r.json()).catch(()=>null)
        if(ps?.models?.length>0){
          const m = ps.models[0]
          const meta = MODEL_META[m.name] || {}
          setActiveModel({
            name: m.name,
            vramMB: Math.round((m.size_vram||0)/1024/1024),
            color: meta.color || '#7c3aed',
            speed: meta.speed || '?',
            ctx: meta.ctx ? parseInt(meta.ctx)*1000 : 4096,
            vram: meta.vram || '?',
          })
        } else {
          // try getting current model from forge settings
          const h = await apiFetch('/health').catch(()=>null)
          if(h?.model) setActiveModel({ name: h.model, vramMB: 0, color:'#52525b', speed:'?', ctx:4096, vram:'?' })
          else setActiveModel(null)
        }
      } catch {}
    }
    poll(); const iv=setInterval(poll,6000); return()=>clearInterval(iv)
  },[])

  // Track ctx used via SSE — sum tokens from done events
  useEffect(()=>{
    const es=new EventSource('/events')
    es.onmessage=e=>{ try{ const d=JSON.parse(e.data); if(d.type==='task_done'&&d.tokens) setCtxUsed(p=>p+d.tokens) }catch{} }
    return()=>es.close()
  },[])

  const ctxPct = activeModel ? Math.min(100, Math.round((ctxUsed/(activeModel.ctx||4096))*100)) : 0
  const ctxColor = ctxPct>80?'#ef4444':ctxPct>60?'#d97706':'#10b981'
  const vramPct = activeModel?.vramMB ? Math.min(100, Math.round((activeModel.vramMB/4096)*100)) : 0

  return (
    <aside className="forge-sidebar">
      <div className="px-4 pt-5 pb-5">
        <div className="flex items-center gap-2.5">
          <div style={{width:28,height:28,borderRadius:8,background:'linear-gradient(135deg,#7c3aed,#4f46e5)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,fontWeight:700,color:'white',boxShadow:'0 4px 12px rgba(124,58,237,0.3)'}}>F</div>
          <GradientText colors={['#a78bfa','#c4b5fd','#7c3aed','#a78bfa']} animationSpeed={8} className="text-base font-bold tracking-tight">The Forge</GradientText>
        </div>
        <ShinyText text="Local AI Dev Team" speed={4} color="#52525b" shineColor="#71717a" className="text-[11px] mt-1 ml-0.5"/>
      </div>
      <nav className="px-2 space-y-0.5 flex-1">
        {NAV.map(({id,Icon,label})=>(
          <button key={id} onClick={()=>setTab(id)}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all duration-150 ${
              tab===id ? 'bg-violet-500/15 text-violet-200' : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
            }`}
            style={tab===id ? {boxShadow:'inset 0 0 0 1px rgba(139,92,246,0.2)'} : {}}>
            <Icon size={15} className="flex-shrink-0"/>
            <span>{label}</span>
            {id==='pipeline' && running && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"/>}
          </button>
        ))}
      </nav>

      {/* Bottom: Active Model card */}
      <div className="px-4 pb-5 mt-auto space-y-2">
        {running && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{background:'rgba(16,185,129,0.08)',border:'1px solid rgba(16,185,129,0.15)'}}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"/>
            <span className="text-[11px] text-emerald-400 font-medium">Pipeline running</span>
          </div>
        )}
        <div className="p-3 rounded-xl space-y-2.5" style={{background:'rgba(255,255,255,0.025)',border:`1px solid ${activeModel?activeModel.color+'30':'rgba(255,255,255,0.06)'}`}}>
          {/* Header */}
          <div className="flex items-center gap-2">
            <Cpu size={11} style={{color: activeModel?.color||'#52525b'}} className="flex-shrink-0"/>
            <span className="text-[10px] text-zinc-500 font-medium uppercase tracking-widest">Active Model</span>
            {activeModel && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" title="Loaded in VRAM"/>}
          </div>

          {activeModel ? (<>
            {/* Model name */}
            <div>
              <p className="text-[12px] font-semibold truncate" style={{color: activeModel.color}} title={activeModel.name}>
                {activeModel.name.split(':')[0].replace('deepseek-','ds-').replace('qwen2.5-','qw-')}
              </p>
              <p className="text-[10px] text-zinc-600">{activeModel.name.includes(':')?activeModel.name.split(':')[1]:''}</p>
            </div>

            {/* Specs row */}
            <div className="grid grid-cols-2 gap-1.5">
              {[
                {label:'Speed', val: activeModel.speed!=='?'?`~${activeModel.speed} t/s`:'—', color:'#a78bfa'},
                {label:'VRAM',  val: activeModel.vramMB>0?`${activeModel.vramMB}MB`: activeModel.vram!=='?'?activeModel.vram:'—', color:'#60a5fa'},
              ].map(({label,val,color:c})=>(
                <div key={label} className="px-2 py-1.5 rounded-lg text-center" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.05)'}}>
                  <p className="text-[11px] font-bold" style={{color:c}}>{val}</p>
                  <p className="text-[9px] text-zinc-700 uppercase">{label}</p>
                </div>
              ))}
            </div>

            {/* VRAM bar */}
            {activeModel.vramMB>0 && (
              <div>
                <div className="flex justify-between mb-0.5">
                  <span className="text-[9px] text-zinc-700">VRAM</span>
                  <span className="text-[9px]" style={{color: vramPct>80?'#ef4444':'#52525b'}}>{activeModel.vramMB}MB / 4096MB</span>
                </div>
                <div className="w-full h-1 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.05)'}}>
                  <div className="h-full rounded-full transition-all" style={{width:`${vramPct}%`, background: vramPct>80?'#ef4444': vramPct>60?'#d97706':activeModel.color}}/>
                </div>
              </div>
            )}

            {/* Context bar */}
            <div>
              <div className="flex justify-between mb-0.5">
                <span className="text-[9px] text-zinc-700">Context</span>
                <span className="text-[9px]" style={{color:ctxColor}}>
                  {ctxUsed>0?`~${ctxUsed} / ${(activeModel.ctx/1000).toFixed(0)}k tok`:`${(activeModel.ctx/1000).toFixed(0)}k max`}
                </span>
              </div>
              <div className="w-full h-1 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.05)'}}>
                <div className="h-full rounded-full transition-all" style={{width:`${ctxPct}%`, background:ctxColor}}/>
              </div>
              {ctxPct>70 && <p className="text-[9px] text-amber-400 mt-0.5">⚠ Context {ctxPct}% full — consider new chat</p>}
            </div>
          </>) : (
            <div className="text-center py-2">
              <p className="text-[11px] text-zinc-600">No model loaded</p>
              <p className="text-[10px] text-zinc-700">Send a chat to load one</p>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

const PROJ_COLORS=['#7c3aed','#0891b2','#059669','#d97706','#dc2626','#db2777','#2563eb']

function ProjectDetail({ project, onClose }) {
  const [files, setFiles] = useState([])
  const [selectedFile, setSelectedFile] = useState(null)
  const [fileContent, setFileContent] = useState('')
  const [loadingFile, setLoadingFile] = useState(false)
  const [tasks, setTasks] = useState([])
  const [runCmd, setRunCmd] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!project) return
    apiFetch(`/projects/${project.id}/files`).then(d => {
      if (d?.files) {
        const interesting = d.files.filter(f =>
          !f.path.includes('node_modules') &&
          !f.path.includes('.git') &&
          f.size < 200000
        )
        setFiles(interesting)
        const hasRunSh = d.files.find(f => f.path === 'run.sh')
        const pp = d.projectPath || `~/forge/projects/${project.id}`
        setRunCmd(`cd ${pp} && ${hasRunSh ? 'bash run.sh' : 'npm start'}`)
      }
    })
    apiFetch(`/projects/${project.id}`).then(d => {
      if (d?.epics) {
        const all = d.epics.flatMap(e => e.tasks || [])
        setTasks(all)
      }
    })
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [project, onClose])

  const loadFile = async (f) => {
    if (selectedFile === f.path) { setSelectedFile(null); setFileContent(''); return }
    setSelectedFile(f.path)
    setLoadingFile(true)
    const r = await fetch('/tools/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read', path: f.fullPath })
    }).then(x => x.json()).catch(() => null)
    setFileContent(r?.content || r?.error || '(empty)')
    setLoadingFile(false)
  }

  const copyRunCmd = () => {
    navigator.clipboard.writeText(runCmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!project) return null
  const done = tasks.filter(t => t.status === 'done')
  const pending = tasks.filter(t => t.status === 'pending')
  const failed = tasks.filter(t => t.status === 'failed')

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4"
      style={{backdropFilter:'blur(12px)',background:'rgba(0,0,0,0.7)'}}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full md:max-w-4xl max-h-[92vh] flex flex-col rounded-t-2xl md:rounded-2xl overflow-hidden"
        style={{background:'rgba(9,9,11,0.98)',border:'1px solid rgba(255,255,255,0.1)',boxShadow:'0 24px 80px rgba(0,0,0,0.8)'}}>
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b flex-shrink-0" style={{borderColor:'rgba(255,255,255,0.07)'}}>
          <div>
            <h2 className="text-sm font-bold text-white">{project.name}</h2>
            <p className="text-xs text-zinc-500 mt-0.5">{project.stack} &middot; {project.description?.slice(0,80)}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 transition-all text-zinc-500 hover:text-white ml-4 flex-shrink-0"><X size={15}/></button>
        </div>
        <div className="flex-1 overflow-y-auto forge-scroll">
          {/* Stats row */}
          <div className="flex gap-3 px-5 py-3 border-b flex-wrap" style={{borderColor:'rgba(255,255,255,0.05)'}}>
            {[
              {label:'Done',    val:done.length,    color:'#10b981'},
              {label:'Pending', val:pending.length, color:'#71717a'},
              {label:'Failed',  val:failed.length,  color:'#ef4444'},
              {label:'Score',   val:project.avg_score>0?`${project.avg_score.toFixed(1)}/10`:'—', color:'#d97706'},
            ].map(({label,val,color})=>(
              <div key={label} className="px-3 py-1.5 rounded-lg" style={{background:'rgba(255,255,255,0.025)'}}>
                <p className="text-[10px] text-zinc-600">{label}</p>
                <p className="text-sm font-bold" style={{color}}>{val}</p>
              </div>
            ))}
            {runCmd && (
              <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg min-w-48 cursor-pointer" onClick={copyRunCmd}
                style={{background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.06)'}}>
                <Terminal size={11} className="text-zinc-500 flex-shrink-0"/>
                <code className="text-[11px] text-zinc-400 flex-1 truncate font-mono">{runCmd}</code>
                <span className="flex-shrink-0" style={{color:copied?'#34d399':'#52525b'}}>{copied?<Check size={11}/>:<Copy size={11}/>}</span>
              </div>
            )}
          </div>
          <div className="flex flex-col md:flex-row min-h-0">
            {/* Left: files */}
            <div className="md:w-56 border-b md:border-b-0 md:border-r flex-shrink-0" style={{borderColor:'rgba(255,255,255,0.05)'}}>
              <p className="px-4 py-2 text-[10px] font-semibold text-zinc-600 uppercase tracking-widest border-b" style={{borderColor:'rgba(255,255,255,0.05)'}}>Files ({files.length})</p>
              <div className="overflow-y-auto forge-scroll" style={{maxHeight:'400px'}}>
                {files.length === 0
                  ? <p className="px-4 py-3 text-xs text-zinc-700">No files yet</p>
                  : files.map(f => (
                    <button key={f.path} onClick={() => loadFile(f)}
                      className={`w-full text-left px-4 py-2 text-[11px] font-mono transition-all hover:bg-white/[0.03] flex items-center gap-2 ${selectedFile===f.path?'text-violet-300 bg-violet-500/10':'text-zinc-500'}`}>
                      <Code2 size={10} className="flex-shrink-0 opacity-50"/>
                      <span className="truncate">{f.path}</span>
                    </button>
                  ))
                }
              </div>
            </div>
            {/* Right: file content or task list */}
            <div className="flex-1 overflow-hidden">
              {selectedFile ? (
                <div className="h-full">
                  <div className="px-4 py-2 border-b flex items-center gap-2" style={{borderColor:'rgba(255,255,255,0.05)'}}>
                    <Code2 size={10} className="text-zinc-600"/>
                    <span className="text-[11px] text-zinc-500 font-mono">{selectedFile}</span>
                  </div>
                  {loadingFile
                    ? <div className="p-4 text-xs text-zinc-600 animate-pulse">Loading...</div>
                    : <pre className="p-4 text-[11px] font-mono text-emerald-300 overflow-auto forge-scroll leading-relaxed whitespace-pre-wrap" style={{maxHeight:'420px'}}>{fileContent.slice(0,4000)}{fileContent.length>4000?'\n... truncated':''}</pre>
                  }
                </div>
              ) : (
                <div className="p-4">
                  <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">Tasks</p>
                  <div className="space-y-1.5 overflow-y-auto forge-scroll" style={{maxHeight:'380px'}}>
                    {tasks.map(t => (
                      <div key={t.id} className="flex items-center gap-3 px-3 py-2 rounded-lg" style={{background:'rgba(255,255,255,0.02)'}}>
                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${t.status==='done'?'bg-emerald-400':t.status==='in_progress'?'bg-blue-400 animate-pulse':t.status==='failed'?'bg-red-400':'bg-zinc-600'}`}/>
                        <span className="text-xs text-zinc-400 flex-1 truncate">{t.title}</span>
                        {t.quality_score!=null && <span className="text-[10px] font-semibold flex-shrink-0" style={{color:t.quality_score>=8?'#10b981':t.quality_score>=6?'#d97706':'#ef4444'}}>{t.quality_score}/10</span>}
                      </div>
                    ))}
                    {!tasks.length && <p className="text-xs text-zinc-700 py-4 text-center">No tasks yet</p>}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Overview({ projects, onRun }) {
  const done=projects.reduce((a,p)=>a+(p.task_done||0),0)
  const total=projects.reduce((a,p)=>a+(p.task_total||0),0)
  const active=projects.filter(p=>p.status==='active').length
  const gpu=useGpu(4000)
  const [buildQ,setBuildQ]=useState('')
  const [buildStack,setBuildStack]=useState('node')
  const [building,setBuilding]=useState(false)
  const [buildResult,setBuildResult]=useState(null)
  const [selectedProject, setSelectedProject] = useState(null)
  const [currentTaskTitle,setCurrentTaskTitle]=useState('')
  const [recentDone, setRecentDone] = useState([])
  const [expandedTask, setExpandedTask] = useState(null)
  useEffect(()=>{
    const load = async () => {
      const all = await apiFetch('/projects')
      if (!Array.isArray(all)) return
      const taskPromises = all.map(p => apiFetch(`/projects/${p.id}`))
      const results = await Promise.all(taskPromises)
      const allDone = []
      results.forEach((r,i) => {
        if (!r?.epics) return
        const proj = all[i]
        r.epics.forEach(e => {
          e.tasks?.forEach(t => {
            if (t.status === 'done' && t.result) allDone.push({...t, projectName: proj.name, projectColor: PROJ_COLORS[i % PROJ_COLORS.length]})
          })
        })
      })
      allDone.sort((a,b) => (b.updated_at||'').localeCompare(a.updated_at||''))
      setRecentDone(allDone.slice(0, 8))
    }
    load()
  },[projects])
  useEffect(()=>{
    const poll=()=>apiFetch('/runner/status').then(d=>{
      if(d?.recentLog){
        const lines=d.recentLog.split('\n').filter(Boolean)
        const running=lines.slice().reverse().find(l=>l.includes('Running:'))
        setCurrentTaskTitle(running?running.replace(/.*Running:\s*/,'').trim():'')
      }
    })
    poll(); const iv=setInterval(poll,5000); return()=>clearInterval(iv)
  },[])
  const scoreProjects=projects.filter(p=>p.avg_score>0)
  const avgScore=scoreProjects.length>0 ? scoreProjects.reduce((a,p)=>a+(p.avg_score||0),0)/scoreProjects.length : 0
  const totalPending=projects.reduce((a,p)=>a+(p.task_pending||0),0)
  const stats=[
    {label:'Projects',   val:projects.length, color:'#7c3aed', Icon:Database},
    {label:'Done Tasks', val:done,             color:'#059669', Icon:CheckCircle2},
    {label:'Queued',     val:totalPending,     color:'#d97706', Icon:Clock},
    {label:'Avg Quality',val:avgScore,         color:'#f59e0b', Icon:Star, isScore:true},
  ]
  const build=async()=>{
    if(!buildQ.trim()||building) return
    setBuilding(true); setBuildResult(null)
    try {
      const r=await fetch('/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({description:buildQ,stack:buildStack,autoRun:true})})
      const d=await r.json()
      setBuildResult(d)
      setBuildQ('')
    } catch { setBuildResult({error:'Build failed'}) }
    finally { setBuilding(false) }
  }
  return (
    <>
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <BlurText text="Command Center" className="text-2xl font-bold text-white" animateBy="words" delay={60}/>
          <p className="text-sm text-zinc-500 mt-1">Autonomous local AI dev team — 100% private</p>
        </div>
        {gpu && (
          <div className="flex items-center gap-4 px-4 py-2.5 rounded-2xl flex-wrap" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)'}}>
            <div className="flex items-center gap-1.5">
              <Thermometer size={13} className="text-orange-400"/>
              <span className="text-xs font-semibold" style={{color:gpu.temp>75?'#ef4444':gpu.temp>60?'#d97706':'#10b981'}}>{gpu.temp}C</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Activity size={13} className="text-violet-400"/>
              <span className="text-xs font-semibold text-violet-300">{gpu.utilization}%</span>
            </div>
            <div className="flex flex-col gap-1 min-w-32">
              <div className="flex items-center gap-1.5">
                <Cpu size={11} className="text-zinc-500"/>
                <span className="text-[10px] text-zinc-500">VRAM</span>
              </div>
              <GpuBar used={gpu.memUsed} total={gpu.memTotal}/>
            </div>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map((s,i)=>(
          <AnimatedContent key={s.label} delay={i*40} distance={20}>
            <div className="forge-stat-card">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-zinc-500">{s.label}</span>
                <s.Icon size={13} style={{color:s.color, opacity:0.7}}/>
              </div>
              <p className="text-3xl font-bold tabular-nums" style={{color:s.color}}>
                {s.isScore ? (avgScore>0?`${avgScore.toFixed(1)}/10`:'—') : <CountUp to={s.val} duration={0.8}/>}
              </p>
            </div>
          </AnimatedContent>
        ))}
      </div>
      <AnimatedContent delay={200} distance={30}>
        <div className="forge-card" style={{background:'linear-gradient(135deg,rgba(124,58,237,0.07),rgba(79,70,229,0.04))',border:'1px solid rgba(124,58,237,0.18)'}}>
          <div className="flex items-center gap-2 mb-3">
            <Flame size={14} className="text-violet-400"/>
            <h2 className="text-sm font-semibold text-white">Build something new</h2>
          </div>
          <div className="flex gap-2 flex-wrap">
            <input value={buildQ} onChange={e=>setBuildQ(e.target.value)} onKeyDown={e=>e.key==='Enter'&&build()}
              placeholder="Describe what you want to build..."
              className="flex-1 min-w-48 rounded-xl px-4 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none transition-all"
              style={{background:'rgba(0,0,0,0.3)',border:'1px solid rgba(255,255,255,0.08)'}}
              onFocus={e=>e.target.style.borderColor='rgba(139,92,246,0.4)'}
              onBlur={e=>e.target.style.borderColor='rgba(255,255,255,0.08)'}/>
            <select value={buildStack} onChange={e=>setBuildStack(e.target.value)}
              className="rounded-xl px-3 py-2.5 text-sm text-zinc-300 focus:outline-none"
              style={{background:'rgba(0,0,0,0.3)',border:'1px solid rgba(255,255,255,0.08)'}}>
              {['node','python','react','go','rust','ts'].map(s=><option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={build} disabled={building||!buildQ.trim()}
              className="px-4 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-30 flex items-center gap-2"
              style={{background:'rgba(124,58,237,0.3)',color:'#c4b5fd',border:'1px solid rgba(124,58,237,0.3)'}}>
              {building ? <RefreshCw size={13} className="animate-spin"/> : <Play size={13}/>}
              {building ? 'Building...' : 'Build'}
            </button>
          </div>
          {buildResult && !buildResult.error && (
            <div className="mt-3 px-3 py-2.5 rounded-xl" style={{background:'rgba(16,185,129,0.08)',border:'1px solid rgba(16,185,129,0.15)'}}>
              <p className="text-xs text-emerald-300 font-semibold">Project created: {buildResult.name}</p>
              <p className="text-[11px] text-emerald-600 mt-0.5">{buildResult.totalTasks} tasks across {buildResult.epics?.length} epics — Pipeline will process tasks automatically</p>
            </div>
          )}
          {buildResult?.error && <p className="mt-2 text-xs text-red-400">{buildResult.error}</p>}
        </div>
      </AnimatedContent>
      {recentDone.length > 0 && (
        <AnimatedContent delay={250} distance={20}>
          <div>
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest mb-3">Recently Built</h2>
            <div className="space-y-2">
              {recentDone.map((t,i) => (
                <div key={t.id||i}>
                  <div
                    onClick={()=>setExpandedTask(expandedTask===t.id?null:t.id)}
                    className="flex items-center gap-3 px-4 py-2.5 rounded-xl cursor-pointer transition-all hover:bg-white/[0.03]"
                    style={{background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.05)'}}>
                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{background:t.projectColor}}/>
                    <span className="text-[11px] text-zinc-600 w-28 truncate flex-shrink-0">{t.projectName}</span>
                    <span className="text-xs text-zinc-300 flex-1 truncate">{t.title}</span>
                    {t.quality_score!=null && (
                      <span className="text-xs font-bold flex-shrink-0" style={{color:t.quality_score>=8?'#10b981':t.quality_score>=6?'#d97706':'#ef4444'}}>{t.quality_score}/10</span>
                    )}
                    <ChevronRight size={12} className="text-zinc-700 flex-shrink-0 transition-transform" style={{transform:expandedTask===t.id?'rotate(90deg)':'none'}}/>
                  </div>
                  {expandedTask===t.id && t.result && (
                    <div className="ml-4 mt-1 rounded-xl overflow-hidden" style={{background:'rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.06)'}}>
                      <pre className="p-3 text-[11px] text-emerald-300 font-mono overflow-x-auto max-h-48 forge-scroll whitespace-pre-wrap leading-relaxed">{t.result.slice(0,2000)}{t.result.length>2000?'\n... (truncated)':''}</pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </AnimatedContent>
      )}
      <div>
        {currentTaskTitle && (
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl mb-4" style={{background:'rgba(59,130,246,0.06)',border:'1px solid rgba(59,130,246,0.18)'}}>
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0"/>
            <span className="text-xs text-blue-300 font-medium">Running:</span>
            <span className="text-xs text-zinc-300 truncate flex-1">{currentTaskTitle}</span>
          </div>
        )}
        <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest mb-3">Projects</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {projects.map((p,i)=>{
            const d=p.task_done||0, t=p.task_total||0, pct=t>0?Math.round((d/t)*100):0
            const col=PROJ_COLORS[i%PROJ_COLORS.length]
            return (
              <AnimatedContent key={p.id} delay={i*50} distance={30}>
                <SpotlightCard spotlightColor={`${col}30`} className="forge-pcard group cursor-pointer" onClick={()=>setSelectedProject(p)}>
                  <div className="flex items-start gap-3">
                    <div className="relative flex-shrink-0">
                      <Ring pct={pct} color={col}/>
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold" style={{color:col}}>{pct}%</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-semibold text-white leading-snug">{p.name}</h3>
                        <Badge status={p.status}/>
                      </div>
                      <p className="text-[11px] text-zinc-500 mt-0.5">{p.stack}</p>
                      <p className="text-[11px] text-zinc-600 mt-1 line-clamp-1">{p.description}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full" style={{background:col}}/>
                      <span className="text-[11px] text-zinc-500">{p.model?.split(':')[0]}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {p.avg_score>0 && <span className="text-[10px] font-bold" style={{color:'#d97706'}}>{p.avg_score.toFixed(1)}&#9733;</span>}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {p.task_running>0 && <span className="text-[10px] px-1.5 py-0.5 rounded font-medium animate-pulse" style={{background:'rgba(59,130,246,0.12)',color:'#60a5fa',border:'1px solid rgba(59,130,246,0.2)'}}>building</span>}
                        <span className="text-[11px] text-zinc-400"><span className="font-semibold text-zinc-200">{d}</span>/{t} tasks</span>
                        {(p.task_pending||0)>0 && <span className="text-[11px] text-zinc-600">{p.task_pending} queued</span>}
                      </div>
                      <button onClick={()=>onRun(p.id)}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all opacity-0 group-hover:opacity-100 flex items-center gap-1.5"
                        style={{background:'rgba(124,58,237,0.15)',color:'#c4b5fd',border:'1px solid rgba(124,58,237,0.25)'}}>
                        <Play size={9}/> Run
                      </button>
                    </div>
                  </div>
                </SpotlightCard>
              </AnimatedContent>
            )
          })}
          {projects.length===0 && (
            <div className="col-span-3 flex flex-col items-center justify-center py-16 rounded-2xl" style={{border:'2px dashed rgba(255,255,255,0.07)'}}>
              <Zap size={32} className="text-zinc-700 mb-3"/>
              <p className="text-sm font-semibold text-zinc-500 mb-1">No projects yet</p>
              <p className="text-xs text-zinc-600">Use the <span className="text-violet-400">Build something new</span> box above — describe a project and hit Build</p>
            </div>
          )}
        </div>
      </div>
    </div>
    {selectedProject && <ProjectDetail project={selectedProject} onClose={()=>setSelectedProject(null)}/>}
    </>
  )
}

const PIPELINE_STAGES=['research','architect','coder','refactor','tester','reviewer','arch-review','debugger','security','docs']

function StageIndicator({ currentStage }) {
  const idx=PIPELINE_STAGES.indexOf(currentStage)
  return (
    <div className="flex items-center gap-0 overflow-x-auto py-1 forge-scroll">
      {PIPELINE_STAGES.map((s,i)=>(
        <div key={s} className="flex items-center flex-shrink-0">
          <div className="flex flex-col items-center gap-1">
            <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold transition-all flex-shrink-0"
              style={{
                background:i<idx?'#10b981':i===idx?'#7c3aed':'rgba(255,255,255,0.04)',
                border:`2px solid ${i<idx?'#10b981':i===idx?'#7c3aed':'rgba(255,255,255,0.1)'}`,
                color:i<=idx?'#fff':'#52525b',
                boxShadow:i===idx?'0 0 10px rgba(124,58,237,0.6)':'none'
              }}>
              {i<idx?'✓':i+1}
            </div>
            <span className="text-[9px] whitespace-nowrap"
              style={{color:i===idx?'#c4b5fd':i<idx?'#6ee7b7':'#52525b',fontWeight:i===idx?700:400}}>
              {s}
            </span>
          </div>
          {i<PIPELINE_STAGES.length-1 && (
            <div className="w-4 h-0.5 mb-3 mx-0.5 flex-shrink-0 transition-all"
              style={{background:i<idx?'#10b981':'rgba(255,255,255,0.07)'}}/>
          )}
        </div>
      ))}
    </div>
  )
}

function Pipeline({ projects }) {
  const [sel,setSel]=useState('')
  const [tasks,setTasks]=useState([])
  const [log,setLog]=useState('')
  const [running,setRunning]=useState(false)
  const [selectedTask,setSelectedTask]=useState(null)
  const [currentStage,setCurrentStage]=useState(null)
  const [runningNext,setRunningNext]=useState(false)
  const [globalRunning,setGlobalRunning]=useState(null)
  const logRef=useRef(null)
  useEffect(()=>{ if(projects.length&&!sel) setSel(projects[0]?.id||'') },[projects])
  useEffect(()=>{
    if(!sel) return
    const load=async()=>{
      const [data,s]=await Promise.all([apiFetch(`/projects/${sel}`),apiFetch('/runner/status')])
      if(data){ const allTasks=data.epics?.flatMap(e=>e.tasks)||[]; setTasks(allTasks) }
      if(s){ setRunning(!!s.running); if(s.recentLog) setLog(s.recentLog) }
      // Find running task across all projects
      const allP=await apiFetch('/projects')
      if(Array.isArray(allP)){
        const runningProj=allP.find(p=>p.task_running>0)
        if(runningProj){
          const pd=await apiFetch(`/projects/${runningProj.id}`)
          const runTask=pd?.epics?.flatMap(e=>e.tasks||[]).find(t=>t.status==='in_progress')
          setGlobalRunning(runTask?{...runTask,projectName:runningProj.name}:null)
        } else {
          setGlobalRunning(null)
        }
      }
    }
    load(); const iv=setInterval(load,3000); return()=>clearInterval(iv)
  },[sel])
  useEffect(()=>{
    const es=new EventSource('/events')
    es.onmessage=(e)=>{
      try{
        const d=JSON.parse(e.data)
        if(d.event==='pipeline_stage') setCurrentStage(d.role||d.stage||null)
        if(d.event==='task_complete'||d.event==='task_start') setCurrentStage(null)
      }catch{}
    }
    return()=>es.close()
  },[])
  useEffect(()=>{ if(logRef.current) logRef.current.scrollTop=logRef.current.scrollHeight },[log])
  const runNext=async()=>{ setRunningNext(true); await fetch('/task/run-next',{method:'POST'}).catch(()=>{}); setRunningNext(false) }
  const [autoRun,setAutoRun]=useState(false)
  const toggleAutoRun=async()=>{
    if(!sel) return
    setAutoRun(v=>!v)
    if(!autoRun) await fetch(`/project/${sel}/auto-run`,{method:'POST'}).catch(()=>{})
  }
  const activeTask=tasks.find(t=>t.status==='in_progress')
  const cols=[
    {key:'pending',    label:'Queued',   dot:'bg-zinc-500',    Icon:Clock},
    {key:'in_progress',label:'Running',  dot:'bg-blue-400',    Icon:Activity},
    {key:'done',       label:'Complete', dot:'bg-emerald-400', Icon:CheckCircle2},
    {key:'failed',     label:'Failed',   dot:'bg-red-400',     Icon:AlertCircle},
  ]
  return (
    <div className="space-y-5">
      <div>
        <BlurText text="Pipeline Monitor" className="text-2xl font-bold text-white" animateBy="words" delay={60}/>
        <p className="text-sm text-zinc-500 mt-1">Real-time task execution across all agents</p>
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        {projects.map(p=>(
          <button key={p.id} onClick={()=>setSel(p.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              sel===p.id ? 'bg-violet-500/15 text-violet-200 border-violet-500/25' : 'text-zinc-500 border-white/[0.06] bg-white/[0.02] hover:text-zinc-300'
            }`}>
            {p.name} <span className="text-zinc-600 ml-1">{p.task_done||0}/{p.task_total||0}</span>
          </button>
        ))}
        <button onClick={runNext} disabled={runningNext}
          className="ml-auto px-3 py-1.5 rounded-lg text-xs font-medium border transition-all disabled:opacity-40 flex items-center gap-1.5"
          style={{background:'rgba(124,58,237,0.15)',color:'#c4b5fd',border:'1px solid rgba(124,58,237,0.25)'}}>
          {runningNext ? <RefreshCw size={11} className="animate-spin"/> : <Play size={11}/>}
          Run Next Task
        </button>
        <button onClick={toggleAutoRun}
          className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-all flex items-center gap-1.5"
          style={{background:autoRun?'rgba(16,185,129,0.12)':'rgba(255,255,255,0.03)',color:autoRun?'#34d399':'#71717a',border:`1px solid ${autoRun?'rgba(16,185,129,0.25)':'rgba(255,255,255,0.08)'}`}}>
          <Zap size={11}/> {autoRun?'Auto: ON':'Auto: OFF'}
        </button>
      </div>
      {/* Stage indicator — always visible so you can see pipeline progress at a glance */}
      <div className="forge-card" style={{border:`1px solid ${(activeTask||running||globalRunning)?'rgba(59,130,246,0.2)':'rgba(255,255,255,0.06)'}`,background:(activeTask||running||globalRunning)?'rgba(59,130,246,0.04)':'rgba(255,255,255,0.01)'}}>
        <div className="flex items-center gap-2 mb-3">
          {(activeTask||running||globalRunning)
            ? <><span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0"/><span className="text-xs font-semibold text-blue-300">Running Now</span></>
            : <><span className="w-1.5 h-1.5 rounded-full bg-zinc-600 flex-shrink-0"/><span className="text-xs font-semibold text-zinc-500">Pipeline Stages</span></>
          }
          {(activeTask||globalRunning) && (
            <span className="text-xs text-zinc-400 flex-1 truncate">
              {globalRunning&&!activeTask&&<span className="text-zinc-600 mr-1">[{globalRunning.projectName}]</span>}
              {(activeTask||globalRunning)?.title}
            </span>
          )}
        </div>
        <StageIndicator currentStage={currentStage}/>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cols.map(({key,label,dot,Icon})=>{
          const items=tasks.filter(t=>t.status===key)
          return (
            <div key={key} className="forge-kanban-col">
              <div className="flex items-center gap-2 mb-3">
                <Icon size={12} className={key==='in_progress'?'text-blue-400 animate-pulse':key==='done'?'text-emerald-400':key==='failed'?'text-red-400':'text-zinc-500'}/>
                <span className="text-xs font-semibold text-zinc-400">{label}</span>
                <span className="ml-auto text-xs text-zinc-600">{items.length}</span>
              </div>
              <div className="space-y-2 max-h-80 overflow-y-auto forge-scroll">
                {items.map(t=>(
                  <div key={t.id}
                    onClick={()=>t.result&&setSelectedTask(t.id)}
                    className={`p-2.5 rounded-lg transition-all ${key==='in_progress'?'ring-1 ring-blue-500/20':''} ${t.result?'cursor-pointer hover:ring-1 hover:ring-violet-500/30':''}`}
                    style={{background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.05)'}}>
                    <p className="text-[11px] font-medium text-zinc-300 leading-snug line-clamp-2">{t.title}</p>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      {t.quality_score!=null && <span className="text-[10px] font-semibold" style={{color:t.quality_score>=8?'#10b981':t.quality_score>=6?'#d97706':'#ef4444'}}>{t.quality_score}/10</span>}
                      {/* always show the multi-agent team badge so users know the full team ran */}
                      <span className="text-[9px] text-zinc-600 px-1 rounded" style={{background:'rgba(124,58,237,0.1)',border:'1px solid rgba(124,58,237,0.15)'}}>9 agents</span>
                      {t.tok_per_sec!=null && <span className="text-[10px] text-zinc-600">{t.tok_per_sec.toFixed(0)}t/s</span>}
                      {t.duration_ms!=null && <span className="text-[10px] text-zinc-600 ml-auto">{(t.duration_ms/1000).toFixed(1)}s</span>}
                      {t.result && <ExternalLink size={9} className="text-zinc-700 ml-auto"/>}
                    </div>
                  </div>
                ))}
                {!items.length && (
                  <p className="text-[11px] text-zinc-700 text-center py-6">
                    {key==='pending'&&tasks.length===0?'Select a project above':'No '+label.toLowerCase()+' tasks'}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {log && (
        <div className="forge-card">
          <div className="flex items-center gap-2 mb-2">
            <Terminal size={12} className="text-emerald-400"/>
            <span className="text-xs font-semibold text-zinc-400">Runner Log</span>
            {running && <span className="ml-auto text-[10px] text-emerald-500 flex items-center gap-1"><span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse"/>live</span>}
          </div>
          <div ref={logRef} className="rounded-xl overflow-y-auto forge-scroll max-h-56 p-3 space-y-0.5" style={{background:'rgba(0,0,0,0.3)',border:'1px solid rgba(255,255,255,0.04)'}}>
            {log.split('\n').filter(Boolean).slice(-25).map((line,i)=>{
              const isBusy=line.includes('[busy]')
              const isErr=line.includes('[net-err]')||line.includes('error')||line.includes('ERROR')
              const isDone=line.includes('done')||line.includes('complete')||line.includes('[ok]')
              const isRunning=line.includes('Running')||line.includes('stage')||line.includes('Starting')
              const col=isBusy?'#d97706':isErr?'#f87171':isDone?'#34d399':isRunning?'#60a5fa':'#71717a'
              return <p key={i} className="text-[10px] font-mono leading-5 whitespace-pre-wrap" style={{color:col}}>{line}</p>
            })}
          </div>
        </div>
      )}
      {selectedTask && <TaskModal taskId={selectedTask} onClose={()=>setSelectedTask(null)}/>}
    </div>
  )
}

const QUICK=[
  {label:'Fix bug',        template:'Fix the bug in '},
  {label:'Add feature',    template:'Add a feature to '},
  {label:'Write tests',    template:'Write tests for '},
  {label:'Explain code',   template:'Explain how this works: '},
  {label:'Review code',    template:'Review this code:\n\n'},
  {label:'Refactor',       template:'Refactor '},
]

function CodeBlock({ code, lang }) {
  const [copied,setCopied]=useState(false)
  const copy=()=>{ navigator.clipboard.writeText(code); setCopied(true); setTimeout(()=>setCopied(false),2000) }
  return (
    <div className="my-2 rounded-lg overflow-hidden" style={{background:'rgba(0,0,0,0.55)',border:'1px solid rgba(255,255,255,0.08)'}}>
      <div className="flex items-center justify-between px-3 py-1.5" style={{background:'rgba(255,255,255,0.03)',borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
        <span className="text-[10px] text-zinc-600 font-mono">{lang||'code'}</span>
        <button onClick={copy} className="flex items-center gap-1 text-[10px] transition-all" style={{color:copied?'#34d399':'#71717a'}}>
          {copied?<Check size={10}/>:<Copy size={10}/>} {copied?'Copied':'Copy'}
        </button>
      </div>
      <pre className="p-3 text-[12px] text-emerald-300 font-mono overflow-x-auto whitespace-pre leading-relaxed">{code}</pre>
    </div>
  )
}

function MessageContent({ content, streaming }) {
  if(!content && !streaming) return null
  const parts=[]; let remaining=content||''; let ki=0
  while(remaining.length>0){
    const idx=remaining.indexOf('```')
    if(idx===-1){ parts.push(<span key={ki++} className="whitespace-pre-wrap">{remaining}</span>); break }
    if(idx>0) parts.push(<span key={ki++} className="whitespace-pre-wrap">{remaining.slice(0,idx)}</span>)
    const end=remaining.indexOf('```',idx+3)
    if(end===-1){ parts.push(<span key={ki++} className="whitespace-pre-wrap">{remaining.slice(idx)}</span>); break }
    const block=remaining.slice(idx+3,end)
    const nl=block.indexOf('\n')
    const lang=nl>=0?block.slice(0,nl).trim():''
    const code=nl>=0?block.slice(nl+1):block
    parts.push(<CodeBlock key={ki++} code={code} lang={lang}/>)
    remaining=remaining.slice(end+3)
  }
  if(streaming) parts.push(<span key={ki++} className="inline-block w-0.5 h-4 bg-violet-400 ml-0.5 animate-pulse align-text-bottom"/>)
  return parts
}

// ── Agent action/result bubbles ─────────────────────────────────────────────
function AgentAction({ event }) {
  const icons = { read:'📂', write:'✏️', run:'▶', thinking:'🤔', error:'⚠' }
  const colors = { read:'rgba(59,130,246,0.08)', write:'rgba(16,185,129,0.08)', run:'rgba(139,92,246,0.08)', error:'rgba(239,68,68,0.08)' }
  const borderColors = { read:'rgba(59,130,246,0.2)', write:'rgba(16,185,129,0.2)', run:'rgba(139,92,246,0.2)', error:'rgba(239,68,68,0.2)' }
  const textColors = { read:'#93c5fd', write:'#6ee7b7', run:'#c4b5fd', error:'#fca5a5' }
  const a = event.action || event.type
  return (
    <div className="flex items-start gap-2 my-1 text-[11px]" style={{opacity:0.85}}>
      <span>{icons[a]||'◆'}</span>
      <div className="px-2 py-1 rounded-md flex-1 font-mono" style={{background:colors[a]||'rgba(255,255,255,0.04)',border:`1px solid ${borderColors[a]||'rgba(255,255,255,0.08)'}`,color:textColors[a]||'#a1a1aa'}}>
        {event.action==='read' && `Reading ${event.path}...`}
        {event.action==='write' && `Writing ${event.path}...`}
        {event.action==='run'  && `$ ${event.command}`}
        {event.type==='result' && event.action==='read'  && `✓ Read ${event.path} (${event.lines} lines)`}
        {event.type==='result' && event.action==='write' && `✓ Written ${event.path} (${event.lines} lines)`}
        {event.type==='result' && event.action==='run'   && (
          <div>
            <div style={{color:event.exitCode===0?'#6ee7b7':'#fca5a5'}}>{event.exitCode===0?'✓':'✗'} exit {event.exitCode??0}</div>
            {event.output && <pre className="mt-1 text-[10px] text-zinc-400 overflow-x-auto whitespace-pre-wrap max-h-40">{event.output.slice(0,800)}</pre>}
          </div>
        )}
        {event.type==='result' && event.error && <span style={{color:'#fca5a5'}}> ✗ {event.error}</span>}
        {event.type==='tool_turn' && `↻ Got results, thinking again...`}
        {event.type==='thinking' && event.iteration>0 && `↻ Iteration ${event.iteration+1}...`}
        {event.type==='error' && `Error: ${event.message}`}
      </div>
    </div>
  )
}

function Chat() {
  const [msgs,setMsgs]=useState([{role:'assistant',content:"Hi! I'm Forge \u2014 your local AI dev assistant. Running 100% locally on your GPU.\n\nDescribe any project idea and I'll plan it out, then queue it for the dev team to build."}])
  const [input,setInput]=useState('')
  const [loading,setLoading]=useState(false)
  const [loadingMsg,setLoadingMsg]=useState('Thinking...')
  const [model,setModel]=useState('')
  const [buildBanner,setBuildBanner]=useState(null)
  const [planCard,setPlanCard]=useState(null)   // structured plan card
  const [planLoading,setPlanLoading]=useState(false)
  const [reloading,setReloading]=useState(false)
  const [ctxWarning,setCtxWarning]=useState(false)
  const [switching,setSwitching]=useState(false)
  const [switchMsg,setSwitchMsg]=useState('')
  const [switchErr,setSwitchErr]=useState('')
  const [agentMode,setAgentMode]=useState(false)
  const [activeProject,setActiveProject]=useState(null)
  const [allProjects,setAllProjects]=useState([])
  const [imgSize,setImgSize]=useState('1024x1024')

  // Session history state
  const [sessions,setSessions]=useState([])
  const [showSessions,setShowSessions]=useState(false)
  const [currentSessionId,setCurrentSessionId]=useState(null)
  const [sessionSaving,setSessionSaving]=useState(false)
  const sessionsRef=useRef(null)

  // Load session list
  const loadSessions=async()=>{
    const d=await apiFetch('/chat/sessions').catch(()=>null)
    if(d&&Array.isArray(d)) setSessions(d)
  }
  useEffect(()=>{ loadSessions() },[])

  // Close sessions panel on outside click
  useEffect(()=>{
    if(!showSessions) return
    const h=e=>{ if(sessionsRef.current&&!sessionsRef.current.contains(e.target)) setShowSessions(false) }
    document.addEventListener('mousedown',h)
    return()=>document.removeEventListener('mousedown',h)
  },[showSessions])

  const saveSession=async()=>{
    if(msgs.filter(m=>m.role==='user').length===0) return
    setSessionSaving(true)
    try{
      const d=await fetch('/chat/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        id:currentSessionId||undefined,
        title:'New Chat',
        model,
        messages:JSON.stringify(msgs.filter(m=>m.role==='user'||m.role==='assistant').map(m=>({role:m.role,content:m.content,model:m.model,stats:m.stats}))),
        tokenCount:msgs.reduce((s,m)=>s+(m.stats?.tokens||0),0)
      })}).then(r=>r.json())
      if(d?.id){ setCurrentSessionId(d.id); await loadSessions() }
    } catch{}
    setSessionSaving(false)
  }

  const loadSession=async(sid)=>{
    const d=await apiFetch(`/chat/sessions/${sid}`).catch(()=>null)
    if(!d) return
    const msgs2=Array.isArray(d.messages)?d.messages:JSON.parse(d.messages||'[]')
    setMsgs(msgs2); setCurrentSessionId(sid)
    if(d.model) setModel(d.model)
    setShowSessions(false)
  }

  const deleteSession=async(e,sid)=>{
    e.stopPropagation()
    await fetch(`/chat/sessions/${sid}`,{method:'DELETE'}).catch(()=>{})
    setSessions(ss=>ss.filter(s=>s.id!==sid))
    if(currentSessionId===sid) setCurrentSessionId(null)
  }

  // Models that generate images instead of text
  const IMAGE_MODEL_IDS=['dall-e-3','dall-e-2','dall-e','flux','stable-diffusion','sdxl','imagen','midjourney','firefly']
  const isImageModel=m=>{const l=(m||'').toLowerCase(); return IMAGE_MODEL_IDS.some(k=>l.includes(k))}
  const isImgMode=isImageModel(model)
  const bottomRef=useRef(null)
  const inputRef=useRef(null)
  const loadTimerRef=useRef(null)
  useEffect(()=>{ bottomRef.current?.scrollIntoView({behavior:'smooth'}) },[msgs,loading])

  // Load projects for agent mode project selector
  useEffect(()=>{
    apiFetch('/projects/overview').then(d=>{
      if(d?.projects) setAllProjects(d.projects)
    })
    const iv=setInterval(()=>{
      apiFetch('/projects/overview').then(d=>{ if(d?.projects) setAllProjects(d.projects) })
    }, 30000)
    return ()=>clearInterval(iv)
  },[])

  const triggerBuild=async(description, plan)=>{
    const desc=(description||'').replace(/\[FORGE_BUILD:.*?\]/gi,'').trim().slice(0,400)||'New project'
    const buildingMsg={role:'assistant',content:'⏳ Creating project — parsing description with AI...',id:'building-'+Date.now()}
    setMsgs(m=>[...m,buildingMsg])
    try {
      const body=plan
        ? {description:plan.description||desc,stack:plan.stack||'node',autoRun:true,plan}
        : {description:desc,stack:'node',autoRun:true}
      const r=await fetch('/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(x=>x.json())
      if(r?.name){
        setMsgs(m=>m.map(x=>x.id===buildingMsg.id?{...x,content:`✅ **${r.name}** created — ${r.totalTasks} tasks queued. Switch to **Pipeline** to watch the dev team build it.`}:x))
      } else {
        setMsgs(m=>m.map(x=>x.id===buildingMsg.id?{...x,content:`❌ Failed to create project: ${r?.error||'unknown error'}. Try clicking "🔨 Build" again.`}:x))
      }
    } catch(e) {
      setMsgs(m=>m.map(x=>x.id===buildingMsg.id?{...x,content:`❌ Build request failed: ${e.message}. Make sure the server is running.`}:x))
    }
    if(plan) setPlanCard(null)
  }

  const planAndBuild=async()=>{
    const convo=msgs.filter(m=>m.role==='user'||m.role==='assistant')
    if(convo.length<2){ setMsgs(m=>[...m,{role:'assistant',content:'Tell me what you want to build first!'}]); return }
    setPlanLoading(true); setPlanCard(null)
    try{
      const r=await fetch('/project/plan-from-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversation:convo})}).then(x=>x.json())
      if(r?.ok && r?.plan) setPlanCard(r.plan)
      else setMsgs(m=>[...m,{role:'assistant',content:'Could not extract a plan from the conversation yet \u2014 describe your project more.'}])
    } catch{ setMsgs(m=>[...m,{role:'assistant',content:'Planning failed \u2014 server may be busy.'}]) }
    finally{ setPlanLoading(false) }
  }

  const sendAgent=async(text)=>{
    const msg=(text||input).trim()
    if(!msg||loading) return
    setInput('')
    const userMsg={role:'user',content:msg}
    setMsgs(m=>[...m,userMsg])
    setLoading(true)
    setLoadingMsg('Agent working...')

    const history=[...msgs,userMsg].filter(m=>m.role==='user'||m.role==='assistant').map(m=>({role:m.role,content:m.content}))

    let currentStreamId=Date.now()
    setMsgs(m=>[...m,{role:'assistant',content:'',streaming:true,id:currentStreamId,model,isAgent:true}])

    try {
      const controller=new AbortController()
      const timeoutId=setTimeout(()=>controller.abort(),600000)
      // If no project selected, use __workspace__ (sandbox dir)
      const projectId=activeProject?.id||'__workspace__'
      const r=await fetch(`/project/${projectId}/agent-chat`,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({message:msg,model,history}),
        signal:controller.signal
      })
      clearTimeout(timeoutId)

      const reader=r.body.getReader()
      const dec=new TextDecoder()
      let buf=''

      while(true){
        const {done,value}=await reader.read()
        if(done) break
        buf+=dec.decode(value,{stream:true})
        const lines=buf.split('\n'); buf=lines.pop()
        for(const line of lines){
          if(!line.startsWith('data:')) continue
          try{
            const d=JSON.parse(line.slice(5).trim())
            if(d.type==='token'){
              setMsgs(m=>m.map(x=>x.id===currentStreamId?{...x,content:x.content+d.token}:x))
            }
            if(d.type==='action'){
              setMsgs(m=>m.map(x=>x.id===currentStreamId?{...x,streaming:false}:x))
              setMsgs(m=>[...m,{role:'agent-event',event:d,id:Date.now()+Math.random()}])
            }
            if(d.type==='result'){
              setMsgs(m=>[...m,{role:'agent-event',event:d,id:Date.now()+Math.random()}])
            }
            if(d.type==='tool_turn'){
              currentStreamId=Date.now()+Math.random()
              setMsgs(m=>[...m,{role:'agent-event',event:d,id:Date.now()+Math.random()},{role:'assistant',content:'',streaming:true,id:currentStreamId,model,isAgent:true}])
            }
            if(d.type==='done'){
              setMsgs(m=>m.map(x=>x.id===currentStreamId?{...x,streaming:false}:x))
            }
            if(d.type==='error'){
              setMsgs(m=>m.map(x=>x.id===currentStreamId?{...x,content:(x.content||'')+'\n\nError: '+d.message,streaming:false}:x))
            }
          }catch{}
        }
      }
    }catch(e){
      setMsgs(m=>m.map(x=>x.id===currentStreamId?{...x,content:'Error: '+e.message,streaming:false}:x))
    }finally{
      setLoading(false)
      setLoadingMsg('Thinking...')
    }
  }

  const send=async(text)=>{
    const msg=text||input.trim(); if(!msg||loading) return
    if(agentMode){ return sendAgent(msg) }  // works with or without project
    setInput('')
    const newMsgs=[...msgs,{role:'user',content:msg}]
    setMsgs(newMsgs); setLoading(true)

    // --- Image generation path ---
    if(isImgMode){
      setLoadingMsg('Generating image...')
      setMsgs(m=>[...m,{role:'assistant',content:'',streaming:true,imageGenerating:true}])
      try{
        const r=await fetch('/chat/generate-image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:msg,model,size:imgSize,n:1})})
        const data=await r.json()
        if(data.error) throw new Error(data.error)
        const images=data.images||[]
        setMsgs(m=>m.map(x=>x.streaming?{...x,streaming:false,imageGenerating:false,images,revisedPrompt:images[0]?.revisedPrompt}:x))
      } catch(e){
        setMsgs(m=>m.map(x=>x.streaming?{...x,streaming:false,imageGenerating:false,content:`❌ Image generation failed: ${e.message}`}:x))
      } finally{ setLoading(false); setLoadingMsg('Thinking...') }
      return
    }

    setLoadingMsg('Thinking...')
    loadTimerRef.current=setTimeout(()=>setLoadingMsg('Loading model into VRAM... (~30s on cold start)'),5000)
    const streamId=Date.now()
    setMsgs(m=>[...m,{role:'assistant',content:'',streaming:true,id:streamId,model}])
    // Build history \u2014 skip the very first assistant greeting (UI-only, never sent to model)
    const history=newMsgs
      .filter(m=>m.role==='user'||m.role==='assistant')
      .filter((m,i)=>!(i===0&&m.role==='assistant'))  // drop initial greeting
      .map(m=>({role:m.role,content:m.content}))
    try {
      const controller=new AbortController()
      const timeoutId=setTimeout(()=>controller.abort(),240000)
      const r=await fetch('/chat/stream',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({message:msg,model,history}),
        signal:controller.signal
      })
      clearTimeout(timeoutId)
      clearTimeout(loadTimerRef.current)
      setLoadingMsg('Thinking...')
      const reader=r.body.getReader(); const dec=new TextDecoder(); let buf=''; let gotData=false; let finalDone=null
      const sendStart=Date.now()
      while(true){
        const {done,value}=await reader.read(); if(done) break
        buf+=dec.decode(value,{stream:true})
        const lines=buf.split('\n'); buf=lines.pop()
        for(const line of lines){
          if(!line.startsWith('data:')) continue
          try{
            const d=JSON.parse(line.slice(5).trim())
            if(d.token){
              if(!gotData){ clearTimeout(loadTimerRef.current); setLoadingMsg('Thinking...') }
              gotData=true
              setMsgs(m=>m.map(x=>x.id===streamId?{...x,content:x.content+d.token}:x))
            }
            if(d.done){
              finalDone=d
              const stats=d.tokens>0?{tokens:d.tokens,promptTokens:d.promptTokens,tokPerSec:d.tokPerSec,durationMs:d.durationMs||(Date.now()-sendStart)}:null
              setMsgs(m=>m.map(x=>x.id===streamId?{...x,streaming:false,stats}:x))
              // Context usage warning \u2014 >70% of model ctx used
              const meta=MODEL_META[model]
              const maxCtx=meta?.ctx?parseInt(meta.ctx)*1000:16000
              if(d.promptTokens>0 && d.promptTokens > maxCtx*0.7) setCtxWarning(true)
              // Auto-build: AI triggered it via [FORGE_BUILD:] tag
              if(d.forgeBuild){
                setMsgs(m=>m.map(x=>x.id===streamId?{...x,content:x.content.replace(/\[FORGE_BUILD:[^\]]*\]/gi,'').trimEnd()}:x))
                setTimeout(()=>triggerBuild(d.forgeBuild),400)
              }
              // Build intent detected by server \u2014 show confirmation banner instead of auto-firing
              else if(d.buildIntent && !d.forgeBuild){
                const convo=msgs.filter(m=>m.role==='user'||m.role==='assistant').slice(-8)
                const desc=convo.map(m=>`${m.role==='user'?'User':'Forge'}: ${m.content}`).join('\n').slice(0,600)
                setBuildBanner({description:desc,source:'intent'})
              }
            }
            if(d.error) setMsgs(m=>m.map(x=>x.id===streamId?{...x,content:`Error: ${d.error}`,streaming:false}:x))
          }catch{}
        }
      }
      if(!gotData){
        setLoadingMsg('Waiting for model...')
        const fb=await fetch('/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg,agent:'orchestrator'})}).then(r=>r.json()).catch(()=>null)
        const reply=fb?.response||fb?.message||fb?.content||'(no response \u2014 model may be busy with pipeline)'
        setMsgs(m=>m.map(x=>x.id===streamId?{...x,content:reply,streaming:false}:x))
      }
    } catch(e) {
      clearTimeout(loadTimerRef.current)
      const errMsg=e.name==='AbortError'
        ?'Request timed out (4 min). The model may be very busy. Try again or switch to a smaller model.'
        :`Connection error: ${e.message}`
      setMsgs(m=>m.map(x=>x.id===streamId?{...x,content:errMsg,streaming:false}:x))
    }
    finally { setLoading(false); setLoadingMsg('Thinking...') }
  }



  const reloadModel=async()=>{
    setReloading(true)
    setCtxWarning(false)
    try{ await fetch('/model/reload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model})}) }
    catch{}
    finally{ setReloading(false) }
  }

  const [chatModels,setChatModels]=useState(Object.keys(MODEL_META)) // all known models shown by default
  const [cloudChatModels,setCloudChatModels]=useState([]) // provider/model pairs
  const [loadedModels,setLoadedModels]=useState([])  // which are currently hot in VRAM
  const [showModelPicker,setShowModelPicker]=useState(false)
  const modelPickerRef=useRef(null)
  const [modelSearch,setModelSearch]=useState('')
  const modelSearchRef=useRef(null)
  const [pipelineBusy,setPipelineBusy]=useState(false)
  const [pipelineTask,setPipelineTask]=useState('')
  useEffect(()=>{
    const loadModels=()=>{
      if(document.visibilityState==='hidden') return
      Promise.all([apiFetch('/models'),apiFetch('/vram/status'),apiFetch('/all-models')]).then(([d,v,allM])=>{
        const raw=d?.models||[]
        // Sort by size ascending — smallest (fastest) first
        const sorted=[...raw].sort((a,b)=>(a.size||Infinity)-(b.size||Infinity))
        const ALL=sorted.map(m=>m.name)
        // Always update — use API list if available, otherwise keep MODEL_META defaults
        setChatModels(ALL.length>0?ALL:Object.keys(MODEL_META))
        if(ALL.length>0) setModel(prev=>prev&&(ALL.includes(prev)||prev.includes('/'))?prev:ALL[0])
        setLoadedModels((v?.loaded||[]).map(m=>typeof m==='string'?m:m.name))
        // Cloud models — keep full objects so we can show free badge
        if(allM?.models){
          setCloudChatModels(allM.models.filter(m=>!m.local))
        }
      }).catch(()=>{})
    }
    loadModels()
    const iv=setInterval(loadModels,12000); return()=>clearInterval(iv)
  },[])
  // Close model picker on outside click
  useEffect(()=>{
    const handler=(e)=>{ if(modelPickerRef.current&&!modelPickerRef.current.contains(e.target)) setShowModelPicker(false) }
    document.addEventListener('mousedown',handler); return()=>document.removeEventListener('mousedown',handler)
  },[])
  useEffect(()=>{
    const pollBusy=()=>apiFetch('/runner/status').then(d=>{
      if(!d) return
      setPipelineBusy(!!d.running)
      if(d.recentLog){
        const lines=d.recentLog.split('\n').filter(Boolean)
        const runLine=lines.slice().reverse().find(l=>l.includes('Running:'))
        setPipelineTask(runLine?runLine.replace(/.*Running:\s*/,'').trim():'')
      }
    })
    pollBusy(); const iv2=setInterval(pollBusy,8000); return()=>clearInterval(iv2)
  },[])
  return (
    <div className="flex flex-col" style={{minHeight:'calc(100vh - 8rem)'}}>
      <div className="flex items-start justify-between mb-4 flex-wrap gap-2">
        <div>
          <BlurText text="Chat with Forge" className="text-2xl font-bold text-white" animateBy="words" delay={60}/>
          <p className="text-sm text-zinc-500 mt-0.5">100% local \u2014 your code never leaves this machine</p>
        </div>
        {/* Model picker trigger + agent project selector */}
        <div className="flex gap-2 items-center flex-wrap">
          {/* Project selector \u2014 only shown in agent mode */}
          {agentMode && (
            <select
              value={activeProject?.id||''}
              onChange={e=>{
                const p=allProjects.find(x=>x.id===e.target.value)
                setActiveProject(p?{id:p.id,name:p.name,stack:p.stack||'node'}:null)
              }}
              style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.1)',borderRadius:'12px',color:'#e4e4e7',fontSize:'12px',padding:'5px 10px',outline:'none',maxWidth:'160px'}}>
              <option value=''>🗂 Sandbox (workspace/)</option>
              {allProjects.map(p=>(
                <option key={p.id} value={p.id} style={{background:'#09090b'}}>{p.name}</option>
              ))}
            </select>
          )}
          <div className="relative" ref={modelPickerRef}>
            <button
              onMouseDown={e=>e.preventDefault()}
              onClick={()=>{ setShowModelPicker(v=>{ if(!v) { setModelSearch(''); setTimeout(()=>modelSearchRef.current?.focus(),50) } return !v }); }}
              disabled={switching}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all disabled:opacity-40"
              style={{background:showModelPicker?'rgba(124,58,237,0.15)':'rgba(255,255,255,0.04)',border:`1px solid ${showModelPicker?'rgba(124,58,237,0.35)':'rgba(255,255,255,0.08)'}`,color:'#e4e4e7'}}>
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{background:MODEL_META[model]?TIER_COLOR[MODEL_META[model].tier]:'#71717a'}}/>
              <span className="max-w-32 truncate">{model||'Loading...'}</span>
              <span className="text-zinc-500 ml-1">{showModelPicker?'\u25b2':'\u25bc'}</span>
            </button>
            {/* Full model picker dropdown — shows ALL installed models */}
            {showModelPicker && (
              <div className="absolute right-0 top-full mt-2 z-50 w-80 rounded-2xl overflow-hidden shadow-2xl"
                style={{background:'rgba(9,9,11,0.98)',border:'1px solid rgba(255,255,255,0.1)',backdropFilter:'blur(20px)'}}>
                {/* Search bar */}
                <div className="px-3 py-2.5 border-b" style={{borderColor:'rgba(255,255,255,0.07)'}}>
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl" style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)'}}>
                    <Search size={11} style={{color:'#52525b',flexShrink:0}}/>
                    <input
                      ref={modelSearchRef}
                      value={modelSearch}
                      onChange={e=>setModelSearch(e.target.value)}
                      onKeyDown={e=>{ if(e.key==='Escape') setShowModelPicker(false) }}
                      placeholder="Search models..."
                      className="flex-1 bg-transparent text-xs text-white placeholder-zinc-600 focus:outline-none"
                    />
                    {modelSearch && (
                      <button onClick={()=>setModelSearch('')} className="text-zinc-600 hover:text-zinc-400">
                        <X size={10}/>
                      </button>
                    )}
                  </div>
                  {!modelSearch && <div className="flex items-center justify-between mt-1.5 px-1">
                    <span className="text-[10px] text-zinc-600">{chatModels.length} local{cloudChatModels.length>0?` · ${cloudChatModels.length} cloud`:''}</span>
                  </div>}
                  {modelSearch && (()=>{
                    const q=modelSearch.toLowerCase()
                    const lc=chatModels.filter(m=>m.toLowerCase().includes(q)).length
                    const cc=cloudChatModels.filter(m=>(m.id||m).toLowerCase().includes(q)||(m.name||'').toLowerCase().includes(q)).length
                    return <span className="text-[10px] text-zinc-600 mt-1 px-1 block">{lc+cc} result{lc+cc!==1?'s':''}</span>
                  })()}
                </div>
                <div className="max-h-96 overflow-y-auto forge-scroll py-1">
                  {/* Local models */}
                  {(()=>{
                    const q=modelSearch.toLowerCase()
                    const filtered=chatModels.filter(m=>!q||m.toLowerCase().includes(q))
                    if(!filtered.length) return null
                    return (
                      <>
                        <div className="px-3 py-1.5">
                          <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">🖥 Local (Ollama)</span>
                        </div>
                        {filtered.map(m=>{
                    const meta=MODEL_META[m]
                    const isActive=model===m
                    const isHot=loadedModels.includes(m)
                    const color=meta?TIER_COLOR[meta.tier]:'#71717a'
                    const vramPct=meta?Math.min(100,parseFloat(meta.vram||'0')*100/4):0
                    const fitsVram=!meta||parseFloat(meta.vram||'0')<=4
                    return (
                      <button key={m}
                        onMouseDown={e=>e.preventDefault()}
                        disabled={switching}
                        onClick={()=>{
                          if(m===model){ setShowModelPicker(false); return }
                          setShowModelPicker(false)
                          setSwitching(true)
                          setSwitchErr('')
                          setSwitchMsg('Switching — evicting VRAM...')
                          setModel(m)
                          fetch('/model/switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:m,from:model})})
                            .then(r=>r.json())
                            .then(d=>{ setSwitchMsg(d.ok?`✅ ${m} ready`:`⚠ ${d.error||'switch failed'}`); setSwitching(false); setTimeout(()=>setSwitchMsg(''),4000) })
                            .catch(e=>{ setSwitchMsg('⚠ switch error'); setSwitching(false); setTimeout(()=>setSwitchMsg(''),3000) })
                          inputRef.current?.focus()
                        }}
                        className="w-full px-4 py-2.5 flex items-center gap-3 text-left transition-all hover:bg-white/[0.04] disabled:opacity-40"
                        style={{background:isActive?'rgba(124,58,237,0.1)':'transparent',borderLeft:isActive?`2px solid ${color}`:'2px solid transparent'}}>
                        <div className="flex-shrink-0">
                          <div className={`w-2 h-2 rounded-full ${isHot?'animate-pulse':''}`} style={{background:isHot?'#10b981':'rgba(255,255,255,0.15)'}}/>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-zinc-200 truncate">{m}</span>
                            {isActive && <span className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 font-bold" style={{background:'rgba(124,58,237,0.2)',color:'#c4b5fd'}}>active</span>}
                            {isHot && !isActive && <span className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0" style={{background:'rgba(16,185,129,0.1)',color:'#34d399'}}>hot</span>}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            {meta && <span className="text-[10px] font-medium" style={{color}}>{meta.tier}</span>}
                            {meta && <span className="text-[10px] text-zinc-600">·</span>}
                            {meta && <span className="text-[10px] text-zinc-600">{meta.speed}</span>}
                            {meta && <span className="text-[10px] text-zinc-600">·</span>}
                            {meta && <span className="text-[10px] text-zinc-600">{meta.ctx} ctx</span>}
                          </div>
                          {meta?.vram && (
                            <div className="mt-1 flex items-center gap-2">
                              <div className="flex-1 h-1 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.06)'}}>
                                <div className="h-full rounded-full" style={{width:`${vramPct}%`,background:parseFloat(meta.vram)>3.8?'#ef4444':parseFloat(meta.vram)>2.5?'#d97706':color}}/>
                              </div>
                              <span className="text-[10px] flex-shrink-0" style={{color:fitsVram?'#52525b':'#ef4444'}}>{meta.vram}{!fitsVram&&' ⚠'}</span>
                            </div>
                          )}
                         </div>
                      </button>
                    )
                  })}
                      </>
                    )
                  })()}
                  {/* Cloud models */}
                  {(()=>{
                    const q=modelSearch.toLowerCase()
                    const filtered=cloudChatModels.filter(mObj=>{
                      const mId=mObj.id||mObj
                      return !q||mId.toLowerCase().includes(q)||(mObj.name||'').toLowerCase().includes(q)
                    })
                    if(!filtered.length) return null
                    return (
                      <>
                        <div className="px-3 pt-3 pb-1.5 border-t mt-1" style={{borderColor:'rgba(255,255,255,0.06)'}}>
                          <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest">☁ Cloud Providers</span>
                        </div>
                        {filtered.map(mObj=>{
                          const mId=mObj.id||mObj
                          const isFree=mObj.free||false
                          const isActive=model===mId
                          const provider=mId.split('/')[0]
                          const PCOL={openai:'#10a37f',anthropic:'#d97706',groq:'#8b5cf6',google:'#3b82f6',openrouter:'#6366f1'}
                          const pCol=PCOL[provider]||'#64748b'
                          const displayName=mObj.name||mId.split('/').slice(1).join('/')||mId
                          return (
                            <button key={mId}
                              onMouseDown={e=>e.preventDefault()}
                              onClick={()=>{
                                setShowModelPicker(false); setModelSearch('')
                                setModel(mId)
                                const prevModel=model
                                if(!prevModel.includes('/')){
                                  setSwitching(true)
                                  setSwitchMsg('☁ Clearing VRAM for cloud model...')
                                  fetch('/model/switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:mId,from:prevModel})})
                                    .then(r=>r.json())
                                    .then(d=>{ setSwitchMsg(d.ok?`☁ ${mId} active — VRAM free`:`⚠ ${d.error||'evict failed'}`); setSwitching(false); setTimeout(()=>setSwitchMsg(''),4000) })
                                    .catch(()=>{ setSwitching(false); setSwitchMsg('⚠ VRAM evict error'); setTimeout(()=>setSwitchMsg(''),3000) })
                                } else {
                                  setSwitchMsg(`☁ ${mId}`)
                                  setTimeout(()=>setSwitchMsg(''),2000)
                                }
                                inputRef.current?.focus()
                              }}
                              className="w-full px-4 py-2.5 flex items-center gap-3 text-left transition-all hover:bg-white/[0.04]"
                              style={{background:isActive?`${pCol}12`:'transparent',borderLeft:isActive?`2px solid ${pCol}`:'2px solid transparent'}}>
                              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{background:isFree?'#10b981':pCol}}/>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs font-semibold text-zinc-200 truncate">{displayName}</span>
                                  {isFree && <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold flex-shrink-0" style={{background:'rgba(16,185,129,0.15)',color:'#34d399',border:'1px solid rgba(16,185,129,0.25)'}}>FREE</span>}
                                  {isActive && <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold flex-shrink-0" style={{background:`${pCol}20`,color:pCol}}>active</span>}
                                </div>
                                <span className="text-[10px] capitalize" style={{color:pCol}}>{provider}</span>
                              </div>
                            </button>
                          )
                        })}
                      </>
                    )
                  })()}
                  {/* No results state */}
                  {modelSearch && (()=>{
                    const q=modelSearch.toLowerCase()
                    const lc=chatModels.filter(m=>m.toLowerCase().includes(q)).length
                    const cc=cloudChatModels.filter(m=>(m.id||m).toLowerCase().includes(q)||(m.name||'').toLowerCase().includes(q)).length
                    if(lc+cc>0) return null
                    return <div className="px-4 py-6 text-center"><p className="text-xs text-zinc-600">No models match "<span className="text-zinc-400">{modelSearch}</span>"</p></div>
                  })()}
                </div>
                <div className="px-4 py-2.5 border-t" style={{borderColor:'rgba(255,255,255,0.07)'}}>
                  <p className="text-[10px] text-zinc-600">Local models evict from VRAM on switch (~10–30s). Switching to cloud clears VRAM automatically. Models &gt;4GB may not load on this GPU.</p>
                </div>
              </div>
            )}
          </div>
          {/* Agent Mode toggle */}
          <button
            onClick={()=>setAgentMode(v=>!v)}
            className="px-2.5 py-1.5 rounded-xl text-[11px] border transition-all flex items-center gap-1"
            style={{background:agentMode?'rgba(16,185,129,0.12)':'rgba(255,255,255,0.03)',color:agentMode?'#34d399':'#71717a',border:`1px solid ${agentMode?'rgba(16,185,129,0.25)':'rgba(255,255,255,0.08)'}`}}>
            {agentMode?'\ud83e\udd16 Agent ON':'\ud83e\udd16 Agent OFF'}
          </button>
          <button onMouseDown={e=>e.preventDefault()} onClick={()=>{ setMsgs([{role:'assistant',content:"Fresh start! What do you want to build or ask?"}]); setBuildBanner(null); setCtxWarning(false); setCurrentSessionId(null); inputRef.current?.focus() }}
            className="px-2.5 py-1.5 rounded-xl text-[11px] text-zinc-500 border border-white/[0.06] hover:text-zinc-300 transition-all">
            Clear
          </button>
          {/* Save session button */}
          <button onMouseDown={e=>e.preventDefault()} onClick={saveSession} disabled={sessionSaving||msgs.filter(m=>m.role==='user').length===0}
            className="px-2.5 py-1.5 rounded-xl text-[11px] border transition-all flex items-center gap-1 disabled:opacity-30"
            style={{background:'rgba(245,158,11,0.08)',color:'#fbbf24',border:'1px solid rgba(245,158,11,0.18)'}}>
            {sessionSaving?<RefreshCw size={9} className="animate-spin"/>:<Save size={9}/>}
            {sessionSaving?'Saving...':'Save'}
          </button>
          {/* History button + dropdown */}
          <div className="relative" ref={sessionsRef}>
            <button onMouseDown={e=>e.preventDefault()} onClick={()=>{ setShowSessions(v=>!v); loadSessions() }}
              className="px-2.5 py-1.5 rounded-xl text-[11px] border transition-all flex items-center gap-1"
              style={{background:showSessions?'rgba(99,102,241,0.12)':'rgba(255,255,255,0.03)',color:showSessions?'#a5b4fc':'#71717a',border:`1px solid ${showSessions?'rgba(99,102,241,0.25)':'rgba(255,255,255,0.08)'}`}}>
              <History size={9}/> History {sessions.length>0&&`(${sessions.length})`}
            </button>
            {showSessions && (
              <div className="absolute right-0 top-full mt-2 z-50 w-72 rounded-2xl shadow-2xl overflow-hidden"
                style={{background:'rgba(9,9,11,0.98)',border:'1px solid rgba(255,255,255,0.1)',backdropFilter:'blur(20px)'}}>
                <div className="px-4 py-3 border-b flex items-center justify-between" style={{borderColor:'rgba(255,255,255,0.07)'}}>
                  <span className="text-xs font-semibold text-zinc-300">Chat History</span>
                  <button onClick={()=>{ setMsgs([{role:'assistant',content:"Fresh start! What do you want to build or ask?"}]); setCurrentSessionId(null); setShowSessions(false) }}
                    className="text-[10px] text-zinc-600 hover:text-zinc-400 flex items-center gap-1">
                    <Plus size={9}/> New
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto forge-scroll py-1">
                  {sessions.length===0 ? (
                    <p className="text-xs text-zinc-600 text-center py-6">No saved sessions yet — hit Save to store this chat</p>
                  ) : sessions.map(s=>(
                    <button key={s.id} onClick={()=>loadSession(s.id)}
                      className="w-full px-4 py-2.5 flex items-start gap-2 text-left transition-all hover:bg-white/[0.04] group"
                      style={{background:currentSessionId===s.id?'rgba(99,102,241,0.08)':'transparent',borderLeft:currentSessionId===s.id?'2px solid #6366f1':'2px solid transparent'}}>
                      <div className="flex-1 min-w-0 mt-0.5">
                        <p className="text-xs font-medium text-zinc-300 truncate">{s.title}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-zinc-600">{s.model?.split('/').pop()?.slice(0,20)||'unknown'}</span>
                          <span className="text-[10px] text-zinc-700">·</span>
                          <span className="text-[10px] text-zinc-600">{new Date(s.updated_at||s.created_at).toLocaleDateString()}</span>
                          {s.token_count>0 && <><span className="text-[10px] text-zinc-700">·</span><span className="text-[10px] text-zinc-600">{s.token_count} tok</span></>}
                        </div>
                      </div>
                      <button onClick={e=>deleteSession(e,s.id)}
                        className="opacity-0 group-hover:opacity-100 text-zinc-700 hover:text-red-400 transition-all p-0.5 flex-shrink-0 mt-0.5">
                        <X size={10}/>
                      </button>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button onMouseDown={e=>e.preventDefault()} onClick={()=>{ reloadModel(); inputRef.current?.focus() }} disabled={reloading} title="Reload model \u2014 clears KV cache, fixes sluggish responses"
            className="px-2.5 py-1.5 rounded-xl text-[11px] text-zinc-500 border border-white/[0.06] hover:text-zinc-300 transition-all disabled:opacity-40 flex items-center gap-1">
            <RefreshCw size={9} className={reloading?'animate-spin':''}/> {reloading?'Reloading...':'Reload'}
          </button>
          <button
            onClick={planAndBuild}
            disabled={planLoading||loading}
            className="px-2.5 py-1.5 rounded-xl text-[11px] border transition-all flex items-center gap-1 disabled:opacity-40"
            style={{background:'rgba(139,92,246,0.12)',color:'#a78bfa',border:'1px solid rgba(139,92,246,0.25)'}}>
            {planLoading?<RefreshCw size={10} className="animate-spin"/>:<Cpu size={10}/>}
            {planLoading?'Planning...':'Plan & Build'}
          </button>
          <button
            onClick={async()=>{
              const convo=msgs.filter(m=>m.role==='user'||m.role==='assistant').slice(-8)
              const desc=convo.map(m=>`${m.role==='user'?'User':'Forge'}: ${m.content}`).join('\n').slice(0,600)||'New project'
              const r=await fetch('/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({description:desc,stack:'node',autoRun:true})}).then(x=>x.json()).catch(()=>null)
              if(r?.name) setMsgs(m=>[...m,{role:'assistant',content:`\u2705 **${r.name}** created \u2014 ${r.totalTasks} tasks queued. Switch to Pipeline to watch it build.`}])
              else setMsgs(m=>[...m,{role:'assistant',content:'Failed to create project.'}])
            }}
            className="px-2.5 py-1.5 rounded-xl text-[11px] border transition-all flex items-center gap-1"
            style={{background:'rgba(16,185,129,0.1)',color:'#34d399',border:'1px solid rgba(16,185,129,0.2)'}}>
            <Play size={10}/> Quick Build
          </button>
        </div>
      </div>
      <div className="flex gap-2 flex-wrap mb-3">
        {QUICK.map(q=>(
          <button key={q.label} onClick={()=>{ setInput(q.template); inputRef.current?.focus() }}
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 transition-all hover:text-zinc-200"
            style={{background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.06)'}}>
            {q.label}
          </button>
        ))}
      </div>
      {(switching || switchErr) && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl mb-2 flex-shrink-0"
          style={{background:switchErr?'rgba(239,68,68,0.08)':'rgba(124,58,237,0.08)',border:`1px solid ${switchErr?'rgba(239,68,68,0.2)':'rgba(124,58,237,0.2)'}`}}>
          {switching && <RefreshCw size={11} className="text-violet-400 animate-spin flex-shrink-0"/>}
          {switchErr && <span className="text-red-400 text-xs flex-shrink-0">\u26a0</span>}
          <span className={`text-xs font-medium flex-1 ${switchErr?'text-red-300':'text-violet-300'}`}>
            {switchErr || switchMsg || `Switching to ${model}... evicting VRAM (~30\u201390s)`}
          </span>
          {switchErr && <button onClick={()=>setSwitchErr('')} className="text-zinc-600 hover:text-zinc-400 flex-shrink-0"><X size={11}/></button>}
        </div>
      )}
      {pipelineBusy && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl mb-2 flex-shrink-0"
          style={{background:'rgba(217,119,6,0.08)',border:'1px solid rgba(217,119,6,0.2)'}}>
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0"/>
          <span className="text-xs text-amber-400 font-medium flex-1 truncate">
            {pipelineTask?`Pipeline running: ${pipelineTask.slice(0,60)}`:'Pipeline running \u2014 responses may be slow'}
          </span>
        </div>
      )}
      {ctxWarning && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl mb-2 flex-shrink-0"
          style={{background:'rgba(239,68,68,0.07)',border:'1px solid rgba(239,68,68,0.2)'}}>
          <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse flex-shrink-0"/>
          <span className="text-xs text-red-400 flex-1">Context window getting full \u2014 responses may degrade</span>
          <button onClick={reloadModel} disabled={reloading}
            className="text-[10px] px-2 py-0.5 rounded-md transition-all disabled:opacity-40"
            style={{background:'rgba(239,68,68,0.15)',color:'#f87171',border:'1px solid rgba(239,68,68,0.3)'}}>
            {reloading?'Reloading...':'Reload Model'}
          </button>
        </div>
      )}
      {buildBanner && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl mb-2 flex-shrink-0"
          style={{background:'rgba(16,185,129,0.08)',border:'1px solid rgba(16,185,129,0.25)'}}>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"/>
          <span className="text-xs text-emerald-300 flex-1">Ready to start development?</span>
          <button onClick={async()=>{ setBuildBanner(null); await triggerBuild(buildBanner.description) }}
            className="text-[10px] px-3 py-1 rounded-md font-semibold transition-all flex items-center gap-1"
            style={{background:'rgba(16,185,129,0.2)',color:'#34d399',border:'1px solid rgba(16,185,129,0.3)'}}>
            <Play size={9}/> Start Dev Team
          </button>
          <button onClick={()=>setBuildBanner(null)} className="text-[10px] text-zinc-600 hover:text-zinc-400 px-1">dismiss</button>
        </div>
      )}
      {planCard && (
        <div className="rounded-2xl mb-3 flex-shrink-0 overflow-hidden" style={{background:'rgba(139,92,246,0.08)',border:'1px solid rgba(139,92,246,0.25)'}}>
          <div className="flex items-center justify-between px-4 py-3" style={{borderBottom:'1px solid rgba(139,92,246,0.15)'}}>
            <div className="flex items-center gap-2">
              <Cpu size={13} className="text-violet-400"/>
              <span className="text-sm font-semibold text-violet-300">{planCard.name}</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full" style={{background:'rgba(139,92,246,0.2)',color:'#a78bfa'}}>{planCard.stack}</span>
            </div>
            <button onClick={()=>setPlanCard(null)} className="text-zinc-600 hover:text-zinc-400 text-xs">\u2715</button>
          </div>
          <div className="px-4 py-3 space-y-3">
            <p className="text-xs text-zinc-400 leading-relaxed">{planCard.description}</p>
            {planCard.features?.length > 0 && (
              <div>
                <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">Features</div>
                <div className="flex flex-wrap gap-1.5">
                  {planCard.features.map((f,i)=>(
                    <span key={i} className="text-[11px] px-2 py-0.5 rounded-lg" style={{background:'rgba(255,255,255,0.05)',color:'#a1a1aa',border:'1px solid rgba(255,255,255,0.07)'}}>{f}</span>
                  ))}
                </div>
              </div>
            )}
            {planCard.epics?.length > 0 && (
              <div>
                <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">Dev Phases \u2014 {planCard.epics.length} epics</div>
                <div className="grid gap-1.5" style={{gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))'}}>
                  {planCard.epics.map((e,i)=>(
                    <div key={i} className="rounded-lg px-3 py-2" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.06)'}}>
                      <div className="text-[11px] font-medium text-zinc-300 mb-1">{e.title}</div>
                      {e.tasks?.map((t,j)=>(
                        <div key={j} className="text-[10px] text-zinc-600 flex items-start gap-1 mb-0.5">
                          <span className="text-violet-600 mt-0.5">\u00b7</span>{t}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button onClick={()=>triggerBuild(planCard.description, planCard)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold transition-all"
                style={{background:'rgba(16,185,129,0.15)',color:'#34d399',border:'1px solid rgba(16,185,129,0.3)'}}>
                <Play size={11}/> Start Dev Team
              </button>
              <button onClick={()=>setPlanCard(null)}
                className="text-xs text-zinc-600 hover:text-zinc-400 px-2 py-2">
                discard
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto forge-scroll space-y-4 mb-4 pr-1" style={{maxHeight:'calc(100vh - 340px)',minHeight:'300px'}}>
        {msgs.map((m,i)=>{
          if(m.role==='agent-event'){
            return <AgentAction key={i} event={m.event}/>
          }
          return (
          <div key={i} className={`flex gap-3 ${m.role==='user'?'flex-row-reverse':''}`}>
            <div className={`w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center text-xs font-bold mt-0.5 ${m.role==='user'?'text-violet-300':'text-zinc-400'}`}
              style={{background:m.role==='user'?'rgba(124,58,237,0.25)':'rgba(255,255,255,0.04)'}}>
              {m.role==='user'?'U':'F'}
            </div>
            <div className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${m.role==='user'?'rounded-tr-sm':'rounded-tl-sm'}`}
              style={m.role==='user'
                ? {background:'rgba(124,58,237,0.15)',color:'white',border:'1px solid rgba(124,58,237,0.2)'}
                : {background:'rgba(255,255,255,0.04)',color:'#d4d4d8',border:'1px solid rgba(255,255,255,0.07)'}}>
              <MessageContent content={m.content} streaming={!!m.streaming}/>
              {/* Image generation output */}
              {m.images && m.images.length>0 && (
                <div className="space-y-2 mt-2">
                  {m.revisedPrompt && <p className="text-[11px] text-zinc-500 italic">Revised: {m.revisedPrompt}</p>}
                  {m.images.map((img,idx)=>(
                    <div key={idx} className="relative rounded-xl overflow-hidden" style={{maxWidth:480}}>
                      <img src={img.b64?`data:image/png;base64,${img.b64}`:img.url} alt="Generated" className="w-full rounded-xl"/>
                      <a href={img.b64?`data:image/png;base64,${img.b64}`:img.url} download={`forge-image-${Date.now()}.png`}
                        className="absolute bottom-2 right-2 flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold hover:opacity-90 transition-opacity"
                        style={{background:'rgba(0,0,0,0.7)',color:'#a3e635',backdropFilter:'blur(4px)'}}>
                        ⬇ Download
                      </a>
                    </div>
                  ))}
                </div>
              )}
              {m.imageGenerating && (
                <div className="flex items-center gap-2 mt-2 text-xs text-zinc-500">
                  {[0,150,300].map(d=><div key={d} className="w-1 h-1 rounded-full bg-lime-400/60 animate-bounce" style={{animationDelay:`${d}ms`}}/>)}
                  Generating image...
                </div>
              )}
              {m.role==='assistant' && !m.streaming && (
                <div className="flex items-center gap-2 mt-2 pt-2 flex-wrap" style={{borderTop:'1px solid rgba(255,255,255,0.05)'}}>
                  <span className="text-[10px] text-zinc-600">{m.model||model}</span>
                  {m.isAgent && <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{background:'rgba(16,185,129,0.1)',color:'#34d399',border:'1px solid rgba(16,185,129,0.2)'}}>&#9889; agent</span>}
                  {m.stats && (()=>{
                    const meta=MODEL_META[m.model||model]
                    const maxCtx=meta?.ctx?parseFloat(meta.ctx)*1000:null
                    const ctxPct=maxCtx&&m.stats.promptTokens>0?Math.round((m.stats.promptTokens/maxCtx)*100):null
                    const ctxColor=ctxPct>85?'#f87171':ctxPct>65?'#fbbf24':'#52525b'
                    return <>
                      <span className="text-[10px] text-zinc-700">\u00b7</span>
                      <span className="text-[10px] text-zinc-600" title="Tokens generated in this response">{m.stats.tokens} tokens</span>
                      {m.stats.tokPerSec>0 && <><span className="text-[10px] text-zinc-700">\u00b7</span><span className="text-[10px] text-zinc-600" title="Generation speed">{m.stats.tokPerSec} tok/s</span></>}
                      {m.stats.durationMs>0 && <><span className="text-[10px] text-zinc-700">\u00b7</span><span className="text-[10px] text-zinc-600" title="Total time to respond">{(m.stats.durationMs/1000).toFixed(1)}s</span></>}
                      {ctxPct!==null && <><span className="text-[10px] text-zinc-700">\u00b7</span><span className="text-[10px] font-medium" style={{color:ctxColor}} title={`Context window usage: ${m.stats.promptTokens} tokens of ${maxCtx} max. Reload model if this gets high.`}>{ctxPct}% window</span></>}
                    </>
                  })()}
                </div>
              )}
            </div>
          </div>
          )
        })}
        {loading && !msgs.find(m=>m.streaming) && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center text-xs text-zinc-400" style={{background:'rgba(255,255,255,0.04)'}}>F</div>
            <div className="rounded-2xl rounded-tl-sm px-4 py-3" style={{background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.07)'}}>
              <div className="flex gap-1.5 items-center flex-wrap">
                {[0,150,300].map(d=><div key={d} className="w-1.5 h-1.5 rounded-full bg-violet-400/60 animate-bounce" style={{animationDelay:`${d}ms`}}/>)}
                <span className="text-xs text-zinc-500 ml-2">{loadingMsg}</span>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef}/>
      </div>
      <div className="relative">
        {/* Image mode size picker */}
        {isImgMode && (
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] text-lime-400 font-semibold flex items-center gap-1">🎨 Image mode</span>
            <span className="text-[10px] text-zinc-600">·</span>
            {['256x256','512x512','1024x1024','1792x1024','1024x1792'].map(s=>(
              <button key={s} onClick={()=>setImgSize(s)}
                className="text-[10px] px-2 py-0.5 rounded-lg transition-all"
                style={imgSize===s?{background:'rgba(163,230,53,0.15)',color:'#a3e635',border:'1px solid rgba(163,230,53,0.3)'}:{color:'#52525b',border:'1px solid rgba(255,255,255,0.06)'}}>
                {s}
              </button>
            ))}
          </div>
        )}
        <textarea ref={inputRef} value={input} onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); if(!switching) send() } }}
          placeholder={isImgMode ? `Describe the image you want to generate (${imgSize})...` : agentMode ? (activeProject ? `Agent: ${activeProject.name} — describe what to build/fix/add...` : 'Agent mode — describe what you want to build or fix (workspace sandbox)...') : switching ? `Loading ${model}...` : 'Ask anything — code, debug, build... (Enter to send, Shift+Enter for newline)'}          disabled={switching}
          rows={3}
          className="w-full rounded-2xl px-5 py-3.5 pr-14 text-sm text-white placeholder-zinc-600 focus:outline-none transition-all resize-none disabled:opacity-50"
          style={{background:'rgba(255,255,255,0.04)',border:`1px solid ${isImgMode?'rgba(163,230,53,0.2)':'rgba(255,255,255,0.08)'}`}}
          onFocus={e=>{e.target.style.borderColor=isImgMode?'rgba(163,230,53,0.4)':'rgba(139,92,246,0.4)';e.target.style.background=isImgMode?'rgba(163,230,53,0.04)':'rgba(124,58,237,0.04)'}}
          onBlur={e=>{e.target.style.borderColor=isImgMode?'rgba(163,230,53,0.2)':'rgba(255,255,255,0.08)';e.target.style.background='rgba(255,255,255,0.04)'}}
        />
        <button onClick={()=>send()} disabled={loading||switching||!input.trim()}
          className="absolute right-3 bottom-3 w-10 h-8 rounded-xl flex items-center justify-center text-sm transition-all disabled:opacity-30"
          style={{background:isImgMode?'rgba(163,230,53,0.2)':'rgba(124,58,237,0.3)',color:isImgMode?'#a3e635':'#c4b5fd'}}>
          {switching?<RefreshCw size={12} className="animate-spin"/>:isImgMode?<span style={{fontSize:14}}>🎨</span>:<Send size={14}/>}
        </button>
      </div>
      <p className="text-[10px] text-zinc-700 mt-1.5 text-center">Enter to send &middot; Shift+Enter for newline &middot; using <span style={{color:MODEL_META[model]?.color||'#71717a'}}>{model}</span></p>
    </div>
  )
}


const MODEL_META={
  'qwen2.5-coder:3b':    {tier:'Workhorse',roles:'coder, refactor, tester, ux',     color:'#7c3aed',speed:'~45 tok/s',ctx:'32k',  vram:'1.9GB'},
  'deepseek-r1:1.5b':    {tier:'Planner',  roles:'architect, reasoning, planning',  color:'#0891b2',speed:'~25 tok/s',ctx:'131k', vram:'1.1GB'},
  'deepseek-coder:1.3b': {tier:'Fast',     roles:'docs, chat, simple tasks',        color:'#059669',speed:'~65 tok/s',ctx:'16k',  vram:'0.8GB'},
  'deepseek-coder:6.7b': {tier:'Auditor',  roles:'reviewer, debugger, security',    color:'#d97706',speed:'~8 tok/s', ctx:'16k',  vram:'3.8GB'},
  'phi3.5-forge:latest': {tier:'Custom',   roles:'fine-tuned forge assistant',      color:'#db2777',speed:'~35 tok/s',ctx:'128k', vram:'2.2GB'},
  'phi3.5:latest':       {tier:'General',  roles:'general reasoning, chat',         color:'#9333ea',speed:'~35 tok/s',ctx:'128k', vram:'2.2GB'},
  'mannix/deepseek-coder-v2-lite-instruct:q2_k': {tier:'Lite',roles:'coder, refactor (quantized)', color:'#0e7490',speed:'~15 tok/s',ctx:'32k',vram:'4.5GB'},
  'qwen3:8b':            {tier:'Large',    roles:'complex reasoning, architecture', color:'#7e22ce',speed:'~6 tok/s', ctx:'32k',  vram:'5.2GB'},
}
const TIER_COLOR={Planner:'#0891b2',Workhorse:'#7c3aed',Auditor:'#d97706',Fast:'#059669',Custom:'#db2777',General:'#9333ea'}

const CustomTooltip=({active,payload,label})=>{
  if(!active||!payload?.length) return null
  return (
    <div className="px-3 py-2 rounded-xl text-xs" style={{background:'rgba(9,9,11,0.95)',border:'1px solid rgba(255,255,255,0.1)',backdropFilter:'blur(8px)'}}>
      <p className="font-semibold text-white mb-1">{label}</p>
      {payload.map(p=><p key={p.name} style={{color:p.fill||p.color}}>{p.name}: {typeof p.value==='number'?p.value.toFixed(1):p.value}</p>)}
    </div>
  )
}

function Models() {
  const [stats,setStats]=useState(null)
  const [history,setHistory]=useState([])
  const [vram,setVram]=useState(null)
  const [localModels,setLocalModels]=useState(()=>Object.keys(MODEL_META).map(name=>{
    const meta=MODEL_META[name]
    return { name, size:null, loaded:false, roles:[], tier:meta.tier, color:meta.color, vram:meta.vram||null, speed:meta.speed||null, ctx:meta.ctx||null, avgScore:0, avgSpeed:0, calls:0 }
  }))   // pre-filled from MODEL_META so panel never shows blank
  const [cloudModels,setCloudModels]=useState([])   // from providers
  const [providers,setProviders]=useState({})        // provider configs
  const [agentRoles,setAgentRoles]=useState({})      // model -> [roles]
  const [refreshing,setRefreshing]=useState(false)
  const [unloading,setUnloading]=useState(null)
  const [tab,setTab]=useState('local') // 'local' | 'cloud' | 'benchmarks'

  const load=useCallback(async()=>{
    const [s,h,v,mods,allM,roles]=await Promise.all([
      apiFetch('/stats/models'),
      apiFetch('/benchmark/history?limit=40'),
      apiFetch('/vram/status'),
      apiFetch('/models'),
      apiFetch('/all-models'),
      apiFetch('/agent-roles'),
    ])
    if(s) setStats(s)
    if(h) setHistory(Array.isArray(h)?h:h.history||[])
    if(v) setVram(v)
    const freshRoles=roles?.roles||{}
    if(roles?.roles) setAgentRoles(freshRoles)

    const loaded=(v?.loaded||[]).map(m=>typeof m==='string'?m:m.name)
    const liveByName={}
    ;(mods?.models||[]).forEach(m=>{ liveByName[m.name]=m })

    // Merge live Ollama models + MODEL_META so we always have full list
    const localNames=[...new Set([
      ...(mods?.models||[]).map(m=>m.name),
      ...Object.keys(MODEL_META)
    ])]
    setLocalModels(localNames.map(name=>{
      const meta=MODEL_META[name]
      const live=liveByName[name]
      const s2=s?.models?.find(x=>x.model===name)
      return { name, size:live?.size||null, loaded:loaded.includes(name), roles:freshRoles[name]||[], tier:meta?.tier||'Local', color:meta?.color||'#71717a', vram:meta?.vram||null, speed:meta?.speed||null, ctx:meta?.ctx||null, avgScore:s2?.avg_score||0, avgSpeed:s2?.avg_tok_per_sec||0, calls:s2?.total_calls||0 }
    }))

    // Cloud models from providers
    if(allM?.models) {
      const cloud=allM.models.filter(m=>!m.local)
      setCloudModels(cloud)
    }
  },[])  // no agentRoles dep — we use freshRoles from the fetch directly

  useEffect(()=>{
    // Load providers config
    apiFetch('/providers').then(d=>{ if(d?.providers) setProviders(d.providers) })
    load()
    const iv=setInterval(()=>{ if(document.visibilityState!=='hidden') load() },6000)
    return()=>clearInterval(iv)
  },[load])

  const refreshAll=async()=>{
    setRefreshing(true)
    try {
      await fetch('/vram/refresh-models',{method:'POST'})
      await load()
      // Re-fetch provider models if any configured
      const ps=await apiFetch('/providers')
      if(ps?.providers) setProviders(ps.providers)
    } catch{}
    setRefreshing(false)
  }

  const unloadModel=async(name)=>{
    setUnloading(name)
    try {
      await Promise.all([
        fetch('/api/generate',{method:'POST',body:JSON.stringify({model:name,keep_alive:0,prompt:''})}).catch(()=>{}),
        fetch('/api/chat',{method:'POST',body:JSON.stringify({model:name,keep_alive:0,messages:[]})}).catch(()=>{})
      ])
      setTimeout(()=>load(),2000)
    } catch{}
    setUnloading(null)
  }

  const getScoreHistory=(name)=>history.filter(h=>h.model===name).slice(-15).map((h,i)=>({i,score:h.quality_score||0}))
  const hotCount=(vram?.loaded||[]).length
  const totalVramGB=(vram?.loaded||[]).reduce((s,m)=>s+(m.vram||0),0)/1e9

  const PROVIDER_ICONS={ openai:'🤖', anthropic:'🧠', groq:'⚡', google:'🔍', openrouter:'🌐', custom:'🔗', ollama:'🖥' }
  const PROVIDER_COLORS={ openai:'#10a37f', anthropic:'#d97706', groq:'#8b5cf6', google:'#3b82f6', openrouter:'#6366f1', custom:'#64748b', ollama:'#7c3aed' }

  return (
    <div className="space-y-5 pb-16">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <BlurText text="Model Fleet" className="text-2xl font-bold text-white" animateBy="words" delay={60}/>
          <p className="text-sm text-zinc-500 mt-0.5">Local Ollama models + cloud providers — all in one place</p>
        </div>
        <button onClick={refreshAll} disabled={refreshing}
          className="px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-40 text-zinc-400 hover:text-zinc-200"
          style={{background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.08)'}}>
          <RefreshCw size={11} className={refreshing?'animate-spin':''}/> {refreshing?'Refreshing...':'Refresh All'}
        </button>
      </div>

      {/* VRAM bar */}
      <div className="forge-card" style={{padding:'14px 18px'}}>
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <span className="text-xs font-semibold text-zinc-300">GPU VRAM — GTX 1650 SUPER (4 GB)</span>
          {hotCount>0 && <span className="text-[10px] text-emerald-400">{hotCount} hot</span>}
          {totalVramGB>0 && <span className="text-[10px] text-zinc-500">{totalVramGB.toFixed(1)} GB / 4 GB used</span>}
        </div>
        <div className="w-full h-3 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.06)'}}>
          <div className="h-full rounded-full transition-all" style={{
            width:`${Math.min(100,totalVramGB/4*100)}%`,
            background:totalVramGB>3.5?'#ef4444':totalVramGB>2.5?'#d97706':'#10b981'
          }}/>
        </div>
        {(vram?.loaded||[]).length>0 && (
          <div className="flex gap-2 flex-wrap mt-2">
            {(vram.loaded||[]).map(m=>{
              const name=typeof m==='string'?m:m.name
              const gb=m.vram?+(m.vram/1e9).toFixed(1):null
              return (
                <span key={name} className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg" style={{background:'rgba(16,185,129,0.1)',border:'1px solid rgba(16,185,129,0.2)',color:'#34d399'}}>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"/>
                  {name}{gb?` · ${gb}GB`:''}
                </span>
              )
            })}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl" style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.06)',width:'fit-content'}}>
        {[['local',`🖥 Local (${localModels.length})`],['cloud',`☁ Cloud (${cloudModels.length})`],['benchmarks','📊 Benchmarks']].map(([t,label])=>(
          <button key={t} onClick={()=>setTab(t)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{background:tab===t?'rgba(124,58,237,0.2)':'transparent',color:tab===t?'#c4b5fd':'#52525b',border:tab===t?'1px solid rgba(124,58,237,0.3)':'1px solid transparent'}}>
            {label}
          </button>
        ))}
      </div>

      {/* Local models */}
      {tab==='local' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {localModels.map((m,i)=>{
            const s2=stats?.models?.find(x=>x.model===m.name)
            const scoreHist=getScoreHistory(m.name)
            const color=m.color
            const vramPct=m.vram?Math.min(100,parseFloat(m.vram)*100/4):null
            const vramOver=m.vram&&parseFloat(m.vram)>4
            const pipelineRoles=(agentRoles[m.name]||[]).join(', ')
            return (
              <div key={m.name} style={{animation:`fadeSlideIn 0.35s ease ${i*60}ms both`}}>
                <SpotlightCard spotlightColor={`${color}25`} className="forge-pcard">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${m.loaded?'animate-pulse':''}`} style={{background:m.loaded?'#10b981':'rgba(255,255,255,0.15)'}}/>
                        <h3 className="text-sm font-semibold text-white truncate max-w-[180px]" title={m.name}>{m.name}</h3>
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full font-semibold flex-shrink-0" style={{background:m.loaded?'rgba(16,185,129,0.15)':'rgba(255,255,255,0.04)',color:m.loaded?'#34d399':'#52525b',border:`1px solid ${m.loaded?'rgba(16,185,129,0.25)':'rgba(255,255,255,0.07)'}`}}>
                          {m.loaded?'● HOT':'○ cold'}
                        </span>
                      </div>
                      {pipelineRoles && <p className="text-[10px] mt-1 ml-4" style={{color}}>{pipelineRoles}</p>}
                      {!pipelineRoles && m.roles?.length===0 && <p className="text-[10px] text-zinc-600 mt-1 ml-4">not used in pipeline — available for chat</p>}
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{background:`${color}18`,color,border:`1px solid ${color}30`}}>{m.tier}</span>
                      {s2?.avg_score>0 && <span className="text-base font-bold" style={{color}}>{s2.avg_score.toFixed(1)}<span className="text-[10px] text-zinc-600">/10</span></span>}
                    </div>
                  </div>

                  {/* VRAM usage bar */}
                  {vramPct!==null && (
                    <div className="mb-3">
                      <div className="flex justify-between mb-1">
                        <span className="text-[10px] text-zinc-600">VRAM usage</span>
                        <span className="text-[10px] font-semibold flex items-center gap-1" style={{color:vramOver?'#ef4444':color}}>
                          {m.vram}{vramOver&&' ⚠ exceeds 4GB'}
                        </span>
                      </div>
                      <div className="w-full h-2 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.06)'}}>
                        <div className="h-full rounded-full" style={{width:`${vramPct}%`,background:vramOver?'#ef4444':parseFloat(m.vram)>3?'#d97706':color,transition:'width 0.5s ease'}}/>
                      </div>
                      <div className="flex justify-between mt-0.5">
                        <span className="text-[9px] text-zinc-700">0 GB</span>
                        <span className="text-[9px] text-zinc-700">4 GB max</span>
                      </div>
                    </div>
                  )}

                  {/* Stats grid — actual measured vs expected */}
                  <div className="grid grid-cols-2 gap-1.5 mb-3">
                    {/* Speed: actual measured vs expected */}
                    <div className="p-2 rounded-lg" style={{background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.05)'}}>
                      <p className="text-[9px] text-zinc-600 mb-1">Speed (tok/s)</p>
                      {s2?.avg_tok_per_sec>0 ? (
                        <div className="space-y-0.5">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] text-zinc-600">Measured</span>
                            <span className="text-[11px] font-bold" style={{color}}>{s2.avg_tok_per_sec.toFixed(0)}</span>
                          </div>
                          {m.speed && (
                            <div className="flex items-center justify-between">
                              <span className="text-[9px] text-zinc-700">Expected</span>
                              <span className="text-[10px] text-zinc-600">{m.speed.replace(' tok/s','')}</span>
                            </div>
                          )}
                          {/* Speed bar: measured vs expected */}
                          {m.speed && (()=>{
                            const exp=parseFloat(m.speed)||1
                            const actual=s2.avg_tok_per_sec
                            const pct=Math.min(100,Math.round(actual/exp*100))
                            return <div className="mt-1 w-full h-1 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.06)'}}><div className="h-full rounded-full" style={{width:`${pct}%`,background:pct>=95?'#10b981':pct>=70?color:'#d97706'}}/></div>
                          })()}
                        </div>
                      ) : (
                        <span className="text-[11px] font-semibold text-zinc-500">{m.speed||'—'} <span className="text-[9px] text-zinc-700">est</span></span>
                      )}
                    </div>
                    {/* Calls + total tokens */}
                    <div className="p-2 rounded-lg" style={{background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.05)'}}>
                      <p className="text-[9px] text-zinc-600 mb-1">Usage</p>
                      <div className="flex items-center justify-between">
                        <span className="text-[9px] text-zinc-600">Calls</span>
                        <span className="text-[11px] font-bold text-zinc-300">{s2?.total_calls>0?s2.total_calls:'—'}</span>
                      </div>
                      {(s2?.total_tokens_out>0) && (
                        <div className="flex items-center justify-between mt-0.5">
                          <span className="text-[9px] text-zinc-700">Tokens</span>
                          <span className="text-[10px] text-zinc-500">{s2.total_tokens_out>999?`${(s2.total_tokens_out/1000).toFixed(1)}k`:s2.total_tokens_out}</span>
                        </div>
                      )}
                      {s2?.last_used && (
                        <div className="flex items-center justify-between mt-0.5">
                          <span className="text-[9px] text-zinc-700">Last</span>
                          <span className="text-[10px] text-zinc-600">{new Date(s2.last_used).toLocaleDateString()}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 mb-3">
                    <div className="p-1.5 rounded-lg text-center" style={{background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.05)'}}>
                      <p className="text-[9px] text-zinc-600 mb-0.5">Ctx</p>
                      <p className="text-[11px] font-semibold text-zinc-300">{m.ctx||'—'}</p>
                    </div>
                    <div className="p-1.5 rounded-lg text-center" style={{background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.05)'}}>
                      <p className="text-[9px] text-zinc-600 mb-0.5">Size</p>
                      <p className="text-[11px] font-semibold text-zinc-300">{m.size?`${(m.size/1e9).toFixed(1)}GB`:(m.vram||'—')}</p>
                    </div>
                  </div>

                  {/* Score sparkline */}
                  {scoreHist.length>1 && (
                    <div className="mb-2">
                      <ResponsiveContainer width="100%" height={36}>
                        <LineChart data={scoreHist}>
                          <Line type="monotone" dataKey="score" stroke={color} strokeWidth={2} dot={false}/>
                          <YAxis domain={[0,10]} hide/>
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}

                  {/* Unload button */}
                  {m.loaded && (
                    <button onClick={()=>unloadModel(m.name)} disabled={unloading===m.name}
                      className="w-full text-[11px] py-1.5 rounded-lg transition-all disabled:opacity-40 mt-1"
                      style={{background:'rgba(239,68,68,0.08)',color:'#fca5a5',border:'1px solid rgba(239,68,68,0.15)'}}>
                      {unloading===m.name?'Unloading...':'Unload from VRAM'}
                    </button>
                  )}
                </SpotlightCard>
              </div>
            )
          })}
          {localModels.length===0 && (
            <div className="forge-card col-span-2 text-center py-12">
              <Cpu size={32} className="text-zinc-700 mx-auto mb-3"/>
              <p className="text-zinc-400 text-sm font-medium">No local models found</p>
              <p className="text-zinc-600 text-xs mt-1">Make sure Ollama is running: <code className="text-violet-400">ollama list</code></p>
            </div>
          )}
        </div>
      )}

      {/* Cloud models */}
      {tab==='cloud' && (()=>{
        const [cloudSearch,setCloudSearch]=React.useState('')
        const [cloudProvider,setCloudProvider]=React.useState('all')
        const q=cloudSearch.toLowerCase()

        // Group cloudModels by provider
        const grouped={}
        cloudModels.forEach(m=>{
          const id=m.id||m
          const prov=id.split('/')[0]
          if(!grouped[prov]) grouped[prov]=[]
          grouped[prov].push(m)
        })
        const providerList=['all',...Object.keys(grouped)]

        const filtered=cloudModels.filter(m=>{
          const id=m.id||m
          const prov=id.split('/')[0]
          const name=(m.name||id).toLowerCase()
          return (cloudProvider==='all'||prov===cloudProvider) && (!q||name.includes(q)||id.toLowerCase().includes(q))
        })

        const freeCount=cloudModels.filter(m=>m.free).length
        const imageModels=['dall-e','flux','stable-diffusion','sdxl','imagen','firefly']
        const isImg=id=>imageModels.some(k=>(id||'').toLowerCase().includes(k))

        if(Object.keys(providers).filter(n=>n!=='ollama').length===0) return (
          <div className="forge-card text-center py-12">
            <p className="text-zinc-400 text-sm font-medium mb-2">No cloud providers configured</p>
            <p className="text-zinc-600 text-xs">Go to <strong className="text-zinc-400">Settings → API Providers</strong> to add OpenAI, Anthropic, OpenRouter, etc.</p>
          </div>
        )

        return (
          <div className="space-y-4">
            {/* Search + filter bar */}
            <div className="flex gap-2 flex-wrap items-center">
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl flex-1 min-w-48" style={{background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.08)'}}>
                <Search size={12} style={{color:'#52525b',flexShrink:0}}/>
                <input value={cloudSearch} onChange={e=>setCloudSearch(e.target.value)}
                  placeholder="Search cloud models..."
                  className="flex-1 bg-transparent text-xs text-white placeholder-zinc-600 focus:outline-none"/>
                {cloudSearch && <button onClick={()=>setCloudSearch('')} className="text-zinc-600 hover:text-zinc-400"><X size={10}/></button>}
              </div>
              <div className="flex gap-1 flex-wrap">
                {providerList.slice(0,6).map(p=>(
                  <button key={p} onClick={()=>setCloudProvider(p)}
                    className="px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all capitalize"
                    style={cloudProvider===p?{background:'rgba(99,102,241,0.2)',color:'#a5b4fc',border:'1px solid rgba(99,102,241,0.3)'}:{background:'rgba(255,255,255,0.03)',color:'#52525b',border:'1px solid rgba(255,255,255,0.06)'}}>
                    {p==='all'?`All (${cloudModels.length})`:p} {p!=='all'&&`(${(grouped[p]||[]).length})`}
                  </button>
                ))}
              </div>
              {freeCount>0 && <span className="text-[10px] px-2 py-1 rounded-lg font-bold" style={{background:'rgba(16,185,129,0.1)',color:'#34d399',border:'1px solid rgba(16,185,129,0.2)'}}>{freeCount} FREE</span>}
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3">
              {[
                {label:'Total Models', val:cloudModels.length, icon:'☁'},
                {label:'Free Models',  val:freeCount,          icon:'🆓', color:'#34d399'},
                {label:'Image Models', val:cloudModels.filter(m=>isImg(m.id||m)).length, icon:'🎨', color:'#a78bfa'},
              ].map(({label,val,icon,color:c})=>(
                <div key={label} className="forge-card text-center py-3">
                  <div className="text-lg mb-0.5">{icon}</div>
                  <div className="text-xl font-bold" style={{color:c||'white'}}>{val}</div>
                  <div className="text-[10px] text-zinc-600">{label}</div>
                </div>
              ))}
            </div>

            {/* Model grid */}
            {filtered.length===0 ? (
              <div className="forge-card text-center py-10">
                <p className="text-zinc-500 text-sm">No models match "<span className="text-zinc-300">{cloudSearch}</span>"</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {filtered.map((m,i)=>{
                  const mid=m.id||m
                  const prov=mid.split('/')[0]
                  const displayName=m.name||mid.split('/').slice(1).join('/')||mid
                  const pCol=PROVIDER_COLORS[prov]||'#64748b'
                  const ctxK=m.context?Math.round(m.context/1000)+'k':null
                  const imgModel=isImg(mid)
                  return (
                    <div key={mid} style={{animation:`fadeSlideIn 0.25s ease ${Math.min(i,20)*30}ms both`}}>
                      <div className="px-4 py-3 rounded-xl transition-all hover:bg-white/[0.03]"
                        style={{background:'rgba(255,255,255,0.02)',border:`1px solid ${m.free?'rgba(16,185,129,0.15)':imgModel?'rgba(167,139,250,0.15)':'rgba(255,255,255,0.06)'}`}}>
                        <div className="flex items-start gap-2">
                          <div className="w-2 h-2 rounded-full mt-1 flex-shrink-0" style={{background:m.free?'#10b981':pCol}}/>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-semibold text-zinc-200 truncate">{displayName}</span>
                              {m.free && <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold flex-shrink-0" style={{background:'rgba(16,185,129,0.15)',color:'#34d399',border:'1px solid rgba(16,185,129,0.25)'}}>FREE</span>}
                              {imgModel && <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold flex-shrink-0" style={{background:'rgba(167,139,250,0.15)',color:'#a78bfa',border:'1px solid rgba(167,139,250,0.25)'}}>🎨 IMG</span>}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className="text-[10px] capitalize font-medium" style={{color:pCol}}>{prov}</span>
                              {ctxK && <><span className="text-[10px] text-zinc-700">·</span><span className="text-[10px] text-zinc-600">{ctxK} ctx</span></>}
                              <span className="text-[10px] text-zinc-700">·</span>
                              <span className="text-[10px] text-zinc-600 font-mono truncate max-w-32">{mid.split('/').slice(1).join('/')}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })()}

      {/* Benchmarks */}
      {tab==='benchmarks' && (
        <div className="space-y-4">
          {/* Global totals strip */}
          {stats?.totals && (
            <div className="grid grid-cols-3 gap-3">
              {[
                {label:'Total Calls', val:stats.totals.total_calls?.toLocaleString()||'0', icon:'📊', color:'#a78bfa'},
                {label:'Total Tokens', val:stats.totals.total_tokens>999?(stats.totals.total_tokens>=1e6?`${(stats.totals.total_tokens/1e6).toFixed(1)}M`:`${(stats.totals.total_tokens/1000).toFixed(1)}k`):(stats.totals.total_tokens||0).toString(), icon:'🔤', color:'#60a5fa'},
                {label:'Avg Speed', val:stats.totals.overall_tok_per_sec>0?`${stats.totals.overall_tok_per_sec} t/s`:'—', icon:'⚡', color:'#34d399'},
              ].map(({label,val,icon,color:c})=>(
                <div key={label} className="forge-card text-center py-3">
                  <div className="text-lg mb-0.5">{icon}</div>
                  <div className="text-xl font-bold" style={{color:c}}>{val}</div>
                  <div className="text-[10px] text-zinc-600">{label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Per-model stats table */}
          {stats?.models?.length>0 && (
            <div className="forge-card">
              <div className="flex items-center gap-2 mb-3">
                <Zap size={13} className="text-violet-400"/>
                <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-widest">Per-Model Stats (all usage)</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr style={{borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
                      {['Model','Calls','Avg Score','Measured t/s','Expected t/s','Δ Speed','Total Tokens','Last Used'].map(h=>(
                        <th key={h} className="text-left py-2 px-2 text-[9px] font-semibold text-zinc-600 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stats.models.map(s=>{
                      const meta=MODEL_META[s.model]
                      const color=meta?.color||'#71717a'
                      const expSpeed=meta?.speed?parseFloat(meta.speed):null
                      const delta=expSpeed&&s.avg_tok_per_sec>0?s.avg_tok_per_sec-expSpeed:null
                      const totalTok=(s.total_tokens_in||0)+(s.total_tokens_out||0)
                      return (
                        <tr key={s.model} className="hover:bg-white/[0.02] transition-colors" style={{borderBottom:'1px solid rgba(255,255,255,0.03)'}}>
                          <td className="py-2 px-2">
                            <div className="flex items-center gap-2">
                              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{background:color}}/>
                              <span className="font-medium text-zinc-300 truncate max-w-32" title={s.model}>{s.model}</span>
                            </div>
                          </td>
                          <td className="py-2 px-2 text-zinc-400 font-semibold">{s.total_calls}</td>
                          <td className="py-2 px-2">
                            {s.avg_score>0 ? (
                              <span className="font-bold" style={{color:s.avg_score>=8?'#10b981':s.avg_score>=6?'#d97706':'#ef4444'}}>{s.avg_score}/10</span>
                            ) : <span className="text-zinc-700">—</span>}
                          </td>
                          <td className="py-2 px-2">
                            {s.avg_tok_per_sec>0
                              ? <span className="font-bold" style={{color}}>{s.avg_tok_per_sec} t/s</span>
                              : <span className="text-zinc-700">—</span>}
                          </td>
                          <td className="py-2 px-2 text-zinc-600">{expSpeed?`~${expSpeed} t/s`:'—'}</td>
                          <td className="py-2 px-2">
                            {delta!==null
                              ? <span className="font-semibold" style={{color:delta>=0?'#10b981':'#f87171'}}>{delta>=0?'+':''}{delta.toFixed(0)} t/s</span>
                              : <span className="text-zinc-700">—</span>}
                          </td>
                          <td className="py-2 px-2 text-zinc-500">{totalTok>999?`${(totalTok/1000).toFixed(1)}k`:totalTok}</td>
                          <td className="py-2 px-2 text-zinc-600 whitespace-nowrap">{s.last_used?new Date(s.last_used).toLocaleDateString():'—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Speed + Score bar charts side by side */}
          {localModels.length>0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                {key:'score',label:'Avg Quality Score (pipeline)',Icon:Star,color:'#f59e0b'},
                {key:'speed',label:'Measured Avg Speed (tok/s)',Icon:Zap,color:'#7c3aed'}
              ].map(({key,label,Icon,color:c})=>(
                <div key={key} className="forge-card">
                  <div className="flex items-center gap-2 mb-4">
                    <Icon size={13} style={{color:c}}/>
                    <h3 className="text-xs font-semibold text-zinc-300">{label}</h3>
                  </div>
                  <ResponsiveContainer width="100%" height={140}>
                    <BarChart data={localModels.map(m=>{
                      const s2=stats?.models?.find(x=>x.model===m.name)
                      const expSpeed=m.speed?parseFloat(m.speed):null
                      return {
                        name:m.name.split(':')[0].replace('deepseek-','ds-').replace('qwen2.5-','qw-').replace('mannix/',''),
                        score:s2?.avg_score||0,
                        speed:s2?.avg_tok_per_sec||0,
                        expected:expSpeed||0
                      }
                    })} margin={{top:4,right:4,left:-20,bottom:4}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                      <XAxis dataKey="name" tick={{fill:'#71717a',fontSize:9}} axisLine={false} tickLine={false}/>
                      <YAxis domain={key==='score'?[0,10]:undefined} tick={{fill:'#71717a',fontSize:10}} axisLine={false} tickLine={false}/>
                      <Tooltip content={<CustomTooltip/>}/>
                      <Bar dataKey={key} name={key==='score'?'Score':'Measured t/s'} radius={[4,4,0,0]}>
                        {localModels.map((m,i)=><Cell key={i} fill={m.color||'#7c3aed'} fillOpacity={0.8}/>)}
                      </Bar>
                      {key==='speed' && <Bar dataKey="expected" name="Expected t/s" radius={[4,4,0,0]} fill="rgba(255,255,255,0.08)"/>}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ))}
            </div>
          )}

          {/* Recent benchmark log */}
          {history.length>0 && (
            <div className="forge-card">
              <div className="flex items-center gap-2 mb-3">
                <BarChart2 size={13} className="text-zinc-400"/>
                <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Recent Activity</h3>
                <span className="text-[10px] text-zinc-700 ml-auto">{history.length} entries</span>
              </div>
              <div className="space-y-0.5 max-h-72 overflow-y-auto forge-scroll">
                {history.map((h,i)=>{
                  const col=MODEL_META[h.model]?.color||'#7c3aed'
                  const stageLabel={'chat':'💬','coder':'⌨️','researcher':'🔬','architect':'📐','reviewer':'🔍','tester':'🧪','security':'🛡','docs':'📄','refactor':'♻️','debugger':'🐛'}[h.pipeline_stage||h.role]||'◆'
                  return (
                    <div key={i} className="flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-white/[0.03]">
                      <span className="text-[11px] flex-shrink-0">{stageLabel}</span>
                      <span className="text-[11px] text-zinc-400 flex-1 truncate">{h.model?.split(':')[0]}</span>
                      <span className="text-[10px] text-zinc-600 w-16 truncate">{h.pipeline_stage||h.role||'—'}</span>
                      <span className="text-[11px] font-medium text-right w-20 flex-shrink-0" style={{color:col}}>
                        {h.tok_per_sec>0?`${h.tok_per_sec.toFixed(0)} t/s`:h.duration_ms?(h.duration_ms/1000).toFixed(1)+'s':'—'}
                      </span>
                      {h.tokens_out>0 && <span className="text-[10px] text-zinc-700 w-12 text-right flex-shrink-0">{h.tokens_out>999?`${(h.tokens_out/1000).toFixed(1)}k`:h.tokens_out}tok</span>}
                      {h.quality_score!=null && <span className="text-[11px] font-semibold w-10 text-right flex-shrink-0" style={{color:h.quality_score>=8?'#10b981':h.quality_score>=6?'#d97706':'#ef4444'}}>{h.quality_score}/10</span>}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {!stats?.models?.length && !history.length && (
            <div className="forge-card text-center py-12">
              <BarChart2 size={32} className="text-zinc-700 mx-auto mb-3"/>
              <p className="text-zinc-400 text-sm font-medium">No benchmark data yet</p>
              <p className="text-zinc-600 text-xs mt-1">Run the pipeline or chat with a model to collect stats</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Settings() {
  const [vram,setVram]=useState(null)
  const [runnerLog,setRunnerLog]=useState('')
  const [runnerRunning,setRunnerRunning]=useState(false)
  const [allProjects,setAllProjects]=useState([])
  const [projFiles,setProjFiles]=useState({})
  const [projExpanded,setProjExpanded]=useState({})
  const [stageToggles,setStageToggles]=useState(()=>Object.fromEntries(PIPELINE_STAGES.map(s=>[s,true])))
  const [roles,setRoles]=useState({})
  const [availableModels,setAvailableModels]=useState([])
  const [savingRoles,setSavingRoles]=useState(false)
  const [saveMsg,setSaveMsg]=useState('')
  const [unloadingModel,setUnloadingModel]=useState(null) // tracks which model is being unloaded
  const [unloadingAll,setUnloadingAll]=useState(false)
  const [vramMsg,setVramMsg]=useState('')
  const gpu=useGpu(5000)
  const refreshVram=()=>apiFetch('/vram/status').then(d=>{ if(d){ setVram(d); setAvailableModels((d.roles||[]).map(r=>r.preferredModel||r.model).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i)); setRoles(Object.fromEntries((d.roles||[]).map(r=>[r.role,r.preferredModel||r.model]))) }})
  useEffect(()=>{ refreshVram() },[])
  useEffect(()=>{
    const poll=()=>apiFetch('/runner/status').then(d=>{ if(d){ setRunnerRunning(!!d.running); setRunnerLog(d.recentLog||'') }})
    poll(); const iv=setInterval(poll,5000); return()=>clearInterval(iv)
  },[])
  useEffect(()=>{ apiFetch('/projects').then(d=>{ if(Array.isArray(d)) setAllProjects(d) }) },[])
  const [mutexMsg,setMutexMsg]=useState('')
  const startRunner=async()=>{ await fetch('/runner/start',{method:'POST'}); setTimeout(()=>apiFetch('/runner/status').then(d=>{ if(d){ setRunnerRunning(!!d.running); setRunnerLog(d.recentLog||'') }}),2500) }
  const stopRunner=async()=>{ await fetch('/runner/stop',{method:'POST'}); setTimeout(()=>apiFetch('/runner/status').then(d=>{ if(d){ setRunnerRunning(!!d.running); setRunnerLog(d.recentLog||'') }}),1000) }
  const reloadRunnerStatus=()=>apiFetch('/runner/status').then(d=>{ if(d){ setRunnerRunning(!!d.running); setRunnerLog(d.recentLog||'') }})
  const resetMutex=async()=>{ const r=await fetch('/mutex/reset',{method:'POST'}).then(x=>x.json()).catch(()=>null); setMutexMsg(r?.ok?`Reset — ${r.reset} task(s) freed`:'Failed'); setTimeout(()=>setMutexMsg(''),4000) }
  const unload=async(model)=>{
    setUnloadingModel(model); setVramMsg('')
    const r=await fetch('/vram/unload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model})}).then(x=>x.json()).catch(()=>null)
    setUnloadingModel(null)
    await refreshVram()
    if(r?.stillLoaded?.length===0 || !r?.stillLoaded?.includes(model)){
      setVramMsg(`✅ ${model} unloaded`)
    } else {
      setVramMsg(`⚠ ${model} may still be loaded — try Force Unload All`)
    }
    setTimeout(()=>setVramMsg(''),5000)
  }
  const unloadAll=async()=>{
    setUnloadingAll(true); setVramMsg('Evicting all models from VRAM...')
    const r=await fetch('/vram/unload-all',{method:'POST'}).then(x=>x.json()).catch(()=>null)
    setUnloadingAll(false)
    await refreshVram()
    if(r?.remaining?.length===0){ setVramMsg(`✅ All ${r?.evicted?.length||0} model(s) evicted — VRAM free`) }
    else { setVramMsg(`⚠ Some models may still be in VRAM: ${(r?.remaining||[]).join(', ')}`) }
    setTimeout(()=>setVramMsg(''),7000)
  }
  const toggleProjFiles=async(id)=>{
    setProjExpanded(e=>({...e,[id]:!e[id]}))
    if(!projFiles[id]){
      const d=await apiFetch(`/projects/${id}/files`)
      setProjFiles(f=>({...f,[id]:Array.isArray(d)?d:(d?.files||[])}))
    }
  }
  const saveRoles=async()=>{
    setSavingRoles(true); setSaveMsg('')
    try {
      await fetch('/vram/roles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roles})})
      setSaveMsg('Saved!')
    } catch { setSaveMsg('Saved locally') }
    setSavingRoles(false); setTimeout(()=>setSaveMsg(''),3000)
  }
  const vramRoles=vram?.roles||[]

  // Provider / API key state
  const [providers,setProviders]=useState({})
  const [providerSaving,setProviderSaving]=useState(null)
  const [providerMsg,setProviderMsg]=useState({})
  const [providerInputs,setProviderInputs]=useState({})
  const [fetchingModels,setFetchingModels]=useState(null)

  const PROVIDER_DEFS=[
    {name:'openrouter',label:'OpenRouter', icon:'🌐', color:'#6366f1', placeholder:'sk-or-v1-...'},
    {name:'openai',   label:'OpenAI',    icon:'🤖', color:'#10a37f', placeholder:'sk-...'},
    {name:'anthropic',label:'Anthropic', icon:'🧠', color:'#d97706', placeholder:'sk-ant-...'},
    {name:'groq',     label:'Groq',      icon:'⚡', color:'#8b5cf6', placeholder:'gsk_...'},
    {name:'google',   label:'Google AI', icon:'🔍', color:'#3b82f6', placeholder:'AIzaSy...'},
    {name:'custom',   label:'Custom API', icon:'🔗', color:'#64748b', placeholder:'sk-...'},
  ]

  useEffect(()=>{
    apiFetch('/providers').then(d=>{
      if(d?.providers){
        setProviders(d.providers)
        const init={}
        Object.entries(d.providers).forEach(([n,v])=>{ init[n]={ apiKey:'', baseUrl:v.baseUrl||'' } })
        setProviderInputs(i=>({...init,...i}))
      }
    })
  },[])

  const saveProvider=async(name)=>{
    const inp=providerInputs[name]||{}
    if(!inp.apiKey&&!providers[name]?.apiKey) { setProviderMsg(m=>({...m,[name]:'⚠ Enter API key first'})); return }
    setProviderSaving(name)
    const body={ name, enabled:true, apiKey:inp.apiKey||undefined, baseUrl:inp.baseUrl||undefined }
    const r=await fetch('/providers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(x=>x.json()).catch(()=>null)
    if(r?.ok){
      setProviderInputs(i=>({...i,[name]:{...i[name],apiKey:''}}))
      apiFetch('/providers').then(d=>{ if(d?.providers) setProviders(d.providers) })
      // Auto-validate key after saving
      setProviderMsg(m=>({...m,[name]:'🔑 Validating key...'}))
      const v=await apiFetch(`/providers/${name}/validate`)
      setProviderSaving(null)
      if(v?.valid){
        setProviderMsg(m=>({...m,[name]:'✅ Key valid & saved!'}))
      } else {
        setProviderMsg(m=>({...m,[name]:`⚠ Saved but key test failed: ${v?.error||'unknown'}. Get a new key from the provider.`}))
      }
    } else {
      setProviderSaving(null)
      setProviderMsg(m=>({...m,[name]:'❌ Failed: '+(r?.error||'unknown error')}))
    }
    setTimeout(()=>setProviderMsg(m=>({...m,[name]:''})),7000)
  }

  const removeProvider=async(name)=>{
    if(!confirm(`Remove ${name} configuration?`)) return
    await fetch(`/providers/${name}`,{method:'DELETE'}).catch(()=>null)
    apiFetch('/providers').then(d=>{ if(d?.providers) setProviders(d.providers) })
  }

  const fetchProviderModels=async(name)=>{
    setFetchingModels(name)
    const r=await fetch(`/providers/${name}/models`).then(x=>x.json()).catch(()=>null)
    setFetchingModels(null)
    if(r?.models){
      setProviderMsg(m=>({...m,[name]:`✅ ${r.models.length} models fetched`}))
      apiFetch('/providers').then(d=>{ if(d?.providers) setProviders(d.providers) })
    } else { setProviderMsg(m=>({...m,[name]:'❌ Failed — check API key'})) }
    setTimeout(()=>setProviderMsg(m=>({...m,[name]:''})),5000)
  }
  return (
    <div className="space-y-6">
      <div>
        <BlurText text="Settings" className="text-2xl font-bold text-white" animateBy="words" delay={60}/>
        <p className="text-sm text-zinc-500 mt-0.5">Agent roles, VRAM control, pipeline config</p>
      </div>
      {gpu === null ? (
        <div className="forge-card">
          <div className="flex items-center gap-2 mb-4">
            <Activity size={13} className="text-violet-400"/>
            <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-widest">GPU Status</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {[...Array(3)].map((_,i)=>(
              <div key={i} className="p-3 rounded-xl animate-pulse" style={{background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.06)'}}>
                <div className="h-2 w-16 bg-white/5 rounded mb-3"/>
                <div className="h-5 w-12 bg-white/5 rounded"/>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="forge-card">
          <div className="flex items-center gap-2 mb-4">
            <Activity size={13} className="text-violet-400"/>
            <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-widest">GPU Status</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              {label:'Temperature', val:`${gpu.temp}C`,  Icon:Thermometer, color:gpu.temp>75?'#ef4444':gpu.temp>60?'#d97706':'#10b981'},
              {label:'Utilization', val:`${gpu.utilization}%`, Icon:Activity, color:'#7c3aed'},
              {label:'VRAM Used',   val:`${gpu.memUsed}MB`,   Icon:Cpu,   color:'#0891b2'},
              {label:'Power Draw',  val:`${gpu.power?.toFixed(0)||'?'}W`,  Icon:Zap,   color:'#d97706'},
            ].map(({label,val,Icon,color})=>(
              <div key={label} className="p-3 rounded-xl" style={{background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.06)'}}>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Icon size={12} style={{color,opacity:0.8}}/>
                  <span className="text-[10px] text-zinc-600">{label}</span>
                </div>
                <p className="text-lg font-bold tabular-nums" style={{color}}>{val}</p>
              </div>
            ))}
          </div>
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-zinc-600">VRAM {gpu.memUsed}/{gpu.memTotal} MB</span>
              <span className="text-[10px] text-zinc-600">{Math.round((gpu.memUsed/gpu.memTotal)*100)}%</span>
            </div>
            <GpuBar used={gpu.memUsed} total={gpu.memTotal}/>
          </div>
        </div>
      )}
      <div className="forge-card">
        <div className="flex items-center gap-2 mb-4">
          <Code2 size={13} className="text-zinc-400"/>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Agent Role Routing</h3>
          <span className="ml-auto text-[10px] text-zinc-600">{vramRoles.length} roles</span>
          <button onClick={saveRoles} disabled={savingRoles}
            className="ml-2 px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-1 transition-all disabled:opacity-50"
            style={{background:'rgba(124,58,237,0.15)',color:'#c4b5fd',border:'1px solid rgba(124,58,237,0.25)'}}>
            <Save size={10}/> {savingRoles?'Saving...':saveMsg||'Save'}
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {vramRoles.length===0
            ? [...Array(4)].map((_,i)=>(
                <div key={i} className="flex items-center gap-3 py-2 px-3 rounded-xl animate-pulse" style={{background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.04)'}}>
                  <div className="h-4 w-14 bg-white/5 rounded-full"/>
                  <div className="h-4 flex-1 bg-white/5 rounded"/>
                </div>
              ))
            : vramRoles.map(r=>{
                const tierKey=r.tier?.charAt(0).toUpperCase()+r.tier?.slice(1)
                const col=TIER_COLOR[tierKey]||'#71717a'
                return (
                  <div key={r.role} className="flex items-center gap-2 py-1.5 px-3 rounded-xl transition-all" style={{background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.04)'}}>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0" style={{background:`${col}18`,color:col}}>{r.tier||tierKey}</span>
                    <span className="text-xs font-semibold text-zinc-300 w-24 flex-shrink-0">{r.role}</span>
                    <select value={roles[r.role]||r.preferredModel||r.model||''} onChange={e=>setRoles(v=>({...v,[r.role]:e.target.value}))}
                      className="flex-1 rounded-lg px-2 py-1 text-xs text-zinc-300 focus:outline-none"
                      style={{background:'rgba(0,0,0,0.3)',border:'1px solid rgba(255,255,255,0.08)'}}>
                      {availableModels.map(m=><option key={m} value={m}>{m}</option>)}
                    </select>
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${r.available!==false?'bg-emerald-400':'bg-zinc-600'}`}/>
                  </div>
                )
              })}
        </div>
      </div>
      {/* Pipeline Stage Toggles */}
      <div className="forge-card">
        <div className="flex items-center gap-2 mb-4">
          <GitBranch size={13} className="text-zinc-400"/>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Pipeline Stages</h3>
          <span className="ml-auto text-[10px] text-zinc-600">{Object.values(stageToggles).filter(Boolean).length}/{PIPELINE_STAGES.length} active</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
          {PIPELINE_STAGES.map(stage=>(
            <div key={stage} onClick={()=>setStageToggles(t=>({...t,[stage]:!t[stage]}))}
              className="flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-all"
              style={{background:'rgba(255,255,255,0.02)',border:`1px solid ${stageToggles[stage]?'rgba(124,58,237,0.25)':'rgba(255,255,255,0.05)'}`,opacity:stageToggles[stage]?1:0.5}}>
              <span className="text-xs font-medium" style={{color:stageToggles[stage]?'#e4e4e7':'#71717a'}}>{stage}</span>
              {stageToggles[stage]?<ToggleRight size={16} style={{color:'#7c3aed',flexShrink:0}}/>:<ToggleLeft size={16} style={{color:'#52525b',flexShrink:0}}/>}
            </div>
          ))}
        </div>
      </div>
      {/* VRAM Control — always shown even if no models loaded so user can see VRAM is free */}
      <div className="forge-card">
        <div className="flex items-center gap-2 mb-3">
          <Database size={13} className="text-zinc-400"/>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">VRAM Control</h3>
          <button onClick={refreshVram} className="ml-auto p-1 rounded hover:bg-white/5 transition-all" title="Refresh VRAM status">
            <RefreshCw size={11} className="text-zinc-600"/>
          </button>
        </div>
        {vramMsg && (
          <div className="mb-3 px-3 py-2 rounded-lg text-xs" style={{background: vramMsg.startsWith('✅')?'rgba(16,185,129,0.08)':vramMsg.startsWith('⚠')?'rgba(245,158,11,0.08)':'rgba(59,130,246,0.08)', color: vramMsg.startsWith('✅')?'#34d399':vramMsg.startsWith('⚠')?'#fbbf24':'#93c5fd', border:`1px solid ${vramMsg.startsWith('✅')?'rgba(16,185,129,0.2)':vramMsg.startsWith('⚠')?'rgba(245,158,11,0.2)':'rgba(59,130,246,0.2)'}`}}>
            {vramMsg}
          </div>
        )}
        {(vram?.loaded||[]).length===0
          ? <p className="text-xs text-zinc-600 py-1">✅ No models loaded — VRAM is free</p>
          : (vram.loaded||[]).map(m=>(
              <div key={m.name} className="flex items-center justify-between py-2 px-3 rounded-xl mb-2" style={{background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.06)'}}>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"/>
                  <div>
                    <p className="text-xs font-semibold text-zinc-300">{m.name}</p>
                    {m.vram && <p className="text-[10px] text-zinc-600">{(m.vram/1e9).toFixed(2)}GB in VRAM</p>}
                  </div>
                </div>
                <button
                  onClick={()=>unload(m.name)}
                  disabled={!!unloadingModel||unloadingAll}
                  className="px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-1 transition-all disabled:opacity-40"
                  style={{background:'rgba(239,68,68,0.1)',color:'#fca5a5',border:'1px solid rgba(239,68,68,0.2)'}}>
                  {unloadingModel===m.name ? <><RefreshCw size={9} className="animate-spin"/> Unloading...</> : <><X size={10}/> Unload</>}
                </button>
              </div>
            ))
        }
        {/* Force Unload All — always visible as nuclear option */}
        <button
          onClick={unloadAll}
          disabled={unloadingAll||!!unloadingModel}
          className="w-full mt-3 px-3 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-40"
          style={{background:'rgba(239,68,68,0.06)',color:'#f87171',border:'1px solid rgba(239,68,68,0.15)'}}>
          {unloadingAll ? <><RefreshCw size={11} className="animate-spin"/> Evicting all models... (may take 30-60s)</> : <><X size={11}/> Force Unload ALL Models</>}
        </button>
        <p className="text-[10px] text-zinc-700 mt-2 text-center">Frees all VRAM. Required before switching to a large model.</p>
      </div>
      <div className="forge-card">
        <div className="flex items-center gap-2 mb-4">
          <Terminal size={13} className="text-zinc-400"/>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">System Info</h3>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[['GPU','GTX 1650 SUPER'],['VRAM','4 GB GDDR6'],['RAM','16 GB'],['Inference','100% Local'],['Server','localhost:3737'],['Version','Forge v3.0']].map(([l,v])=>(
            <div key={l} className="flex items-center justify-between px-3 py-2 rounded-lg" style={{background:'rgba(255,255,255,0.02)'}}>
              <span className="text-[11px] text-zinc-600">{l}</span>
              <span className="text-[11px] font-medium text-zinc-400">{v}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="forge-card">
        <div className="flex items-center gap-2 mb-3">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${runnerRunning?'bg-emerald-400 animate-pulse':'bg-zinc-600'}`}/>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Auto-Runner</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full ml-1" style={{background:runnerRunning?'rgba(16,185,129,0.1)':'rgba(113,113,122,0.1)',color:runnerRunning?'#34d399':'#71717a',border:`1px solid ${runnerRunning?'rgba(16,185,129,0.2)':'rgba(113,113,122,0.2)'}`}}>{runnerRunning?'running':'stopped'}</span>
        <div className="ml-auto flex gap-2 items-center">
            <button onClick={reloadRunnerStatus}
              className="p-1 rounded-lg hover:bg-white/5 transition-all text-zinc-600 hover:text-zinc-400" title="Reload">
              <RefreshCw size={11}/>
            </button>
            <button onClick={resetMutex}
              className="px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-1 transition-all"
              style={{background:'rgba(217,119,6,0.12)',color:mutexMsg?'#34d399':'#fbbf24',border:`1px solid ${mutexMsg?'rgba(52,211,153,0.25)':'rgba(217,119,6,0.25)'}`}}
              title="Release stuck pipeline lock">
              {mutexMsg||'Reset Mutex'}
            </button>
            {!runnerRunning && <button onClick={startRunner} className="px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-1 transition-all" style={{background:'rgba(124,58,237,0.15)',color:'#a78bfa',border:'1px solid rgba(124,58,237,0.25)'}}>&#9654; Start</button>}
            {runnerRunning  && <button onClick={stopRunner}  className="px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-1 transition-all" style={{background:'rgba(239,68,68,0.1)',color:'#fca5a5',border:'1px solid rgba(239,68,68,0.2)'}}>&#9632; Stop</button>}
          </div>
        </div>
        {runnerLog && (
          <div className="rounded-xl overflow-hidden max-h-52" style={{background:'rgba(0,0,0,0.35)',border:'1px solid rgba(255,255,255,0.04)'}}>
            <div className="overflow-y-auto max-h-52 forge-scroll p-3 space-y-0.5">
              {runnerLog.split('\n').filter(Boolean).slice(-20).map((line,i)=>{
                const isBusy=line.includes('[busy]')
                const isErr=line.includes('[net-err]')||line.includes('error')||line.includes('ERROR')
                const isDone=line.includes('done')||line.includes('complete')||line.includes('[ok]')
                const isRunning=line.includes('Running')||line.includes('stage')||line.includes('Starting')
                const col=isBusy?'#d97706':isErr?'#f87171':isDone?'#34d399':isRunning?'#60a5fa':'#71717a'
                return <p key={i} className="text-[10px] font-mono leading-5 whitespace-pre-wrap" style={{color:col}}>{line}</p>
              })}
            </div>
          </div>
        )}
        {!runnerLog && <p className="text-xs text-zinc-600">No log entries yet</p>}
      </div>
      <div className="forge-card">
        <div className="flex items-center gap-2 mb-4">
          <ChevronRight size={13} className="text-zinc-400"/>
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Project Files</h3>
        </div>
        {allProjects.length===0
          ? <p className="text-xs text-zinc-600">No projects found</p>
          : <div className="space-y-1.5">
              {allProjects.map(p=>(
                <div key={p.id}>
                  <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.06)'}}>
                    <span className="text-xs font-medium text-zinc-300 flex-1 truncate">{p.name}</span>
                    <button onClick={()=>toggleProjFiles(p.id)}
                      className="px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-1 transition-all ml-2"
                      style={{background:'rgba(255,255,255,0.04)',color:'#a1a1aa',border:'1px solid rgba(255,255,255,0.08)'}}>
                      <ChevronRight size={10} style={{transform:projExpanded[p.id]?'rotate(90deg)':'none',transition:'transform 0.2s'}}/> Open
                    </button>
                  </div>
                  {projExpanded[p.id] && (
                    <div className="ml-3 mt-1 space-y-0.5 max-h-40 overflow-y-auto forge-scroll">
                      {(projFiles[p.id]||[]).length===0
                        ? <p className="text-[11px] text-zinc-700 py-2 pl-2">No files found</p>
                        : (projFiles[p.id]||[]).map((f,i)=>(
                            <p key={i} className="text-[11px] text-zinc-500 py-1 px-2 rounded font-mono" style={{background:'rgba(255,255,255,0.02)'}}>{typeof f==='string'?f:f.path||f.name||JSON.stringify(f)}</p>
                          ))
                      }
                    </div>
                  )}
                </div>
              ))}
            </div>
        }
      </div>

      {/* ── API Providers ── */}
      <div className="forge-card">
        <div className="flex items-center gap-2 mb-5">
          <span className="text-sm">🔑</span>
          <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-widest">API Providers</h3>
          <span className="text-[10px] text-zinc-600 ml-1">Connect cloud models — use as <code className="text-violet-400">provider/model</code> in Chat</span>
        </div>
        <div className="space-y-4">
          {PROVIDER_DEFS.map(pd=>{
            const cfg=providers[pd.name]
            const inp=providerInputs[pd.name]||{}
            const hasKey=!!cfg?.apiKey
            const isCustom=pd.name==='custom'
            return (
              <div key={pd.name} className="p-4 rounded-xl" style={{background:'rgba(255,255,255,0.025)',border:`1px solid ${hasKey?pd.color+'30':'rgba(255,255,255,0.06)'}`}}>
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-base">{pd.icon}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{pd.label}</span>
                      {hasKey && <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{background:'rgba(16,185,129,0.15)',color:'#34d399',border:'1px solid rgba(16,185,129,0.2)'}}>✓ configured</span>}
                      {cfg?.models?.length>0 && <span className="text-[10px] text-zinc-500">{cfg.models.length} models</span>}
                    </div>
                    <p className="text-[10px] text-zinc-600 mt-0.5">
                      {hasKey?`Key: ${cfg.apiKey}`:'No API key saved'}
                    </p>
                  </div>
                  {hasKey && (
                    <button onClick={()=>removeProvider(pd.name)} className="text-[10px] text-red-400/60 hover:text-red-400 transition-colors">Remove</button>
                  )}
                </div>
                <div className="flex gap-2 flex-wrap">
                  <input
                    type="password"
                    placeholder={pd.placeholder}
                    value={inp.apiKey||''}
                    onChange={e=>setProviderInputs(i=>({...i,[pd.name]:{...i[pd.name],apiKey:e.target.value}}))}
                    className="flex-1 min-w-0 px-3 py-2 rounded-lg text-xs font-mono text-zinc-300"
                    style={{background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.08)',outline:'none'}}
                  />
                  {isCustom && (
                    <input
                      type="text"
                      placeholder="Base URL (e.g. http://localhost:8080/v1)"
                      value={inp.baseUrl||''}
                      onChange={e=>setProviderInputs(i=>({...i,[pd.name]:{...i[pd.name],baseUrl:e.target.value}}))}
                      className="w-full px-3 py-2 rounded-lg text-xs text-zinc-300 mt-1"
                      style={{background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.08)',outline:'none'}}
                    />
                  )}
                  <button onClick={()=>saveProvider(pd.name)} disabled={providerSaving===pd.name}
                    className="px-3 py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-40 flex-shrink-0"
                    style={{background:`${pd.color}20`,color:pd.color,border:`1px solid ${pd.color}40`}}>
                    {providerSaving===pd.name?'Saving...':'Save Key'}
                  </button>
                  {hasKey && (
                    <button onClick={()=>fetchProviderModels(pd.name)} disabled={fetchingModels===pd.name}
                      className="px-3 py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-40 flex-shrink-0 flex items-center gap-1.5"
                      style={{background:'rgba(255,255,255,0.04)',color:'#a1a1aa',border:'1px solid rgba(255,255,255,0.08)'}}>
                      <RefreshCw size={10} className={fetchingModels===pd.name?'animate-spin':''}/> {fetchingModels===pd.name?'Fetching...':'Fetch Models'}
                    </button>
                  )}
                </div>
                {providerMsg[pd.name] && <p className="text-[11px] mt-2" style={{color:providerMsg[pd.name]?.startsWith('✅')?'#34d399':providerMsg[pd.name]?.startsWith('⚠')?'#f59e0b':'#f87171'}}>{providerMsg[pd.name]}</p>}
                {/* Show model list */}
                {cfg?.models?.length>0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {cfg.models.map(mid=>(
                      <span key={mid} className="text-[10px] px-2 py-1 rounded-lg font-mono" style={{background:'rgba(255,255,255,0.03)',color:'#71717a',border:'1px solid rgba(255,255,255,0.06)'}}>
                        {pd.name}/{mid}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Data Safety & Backups ── */}
      {(()=>{
        const [backupFiles,setBackupFiles]=React.useState([])
        const [backing,setBacking]=React.useState(false)
        const [backupMsg,setBackupMsg]=React.useState('')
        React.useEffect(()=>{ apiFetch('/backup/list').then(d=>{ if(d?.files) setBackupFiles(d.files) }) },[])
        const runBackup=async()=>{
          setBacking(true); setBackupMsg('')
          const r=await fetch('/backup/now',{method:'POST'}).then(x=>x.json()).catch(()=>null)
          setBacking(false)
          if(r?.ok){ setBackupMsg(`✅ Backup complete — ${r.files} file(s) saved`) }
          else { setBackupMsg('⚠ Backup failed') }
          apiFetch('/backup/list').then(d=>{ if(d?.files) setBackupFiles(d.files) })
          setTimeout(()=>setBackupMsg(''),6000)
        }
        return (
          <div className="forge-card">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-sm">💾</span>
              <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-widest">Data Safety &amp; Backups</h3>
              <span className="text-[10px] text-zinc-600 ml-1">Auto-backup every 30 min · keeps last 5 per file</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              {[
                {label:'DBs Tracked', val:'3', icon:'🗄', color:'#7c3aed'},
                {label:'JSON Files', val:'2', icon:'📄', color:'#0891b2'},
                {label:'Backups Saved', val:backupFiles.length, icon:'📦', color:'#10b981'},
                {label:'Auto-Save', val:'30 min', icon:'⏱', color:'#d97706'},
              ].map(({label,val,icon,color:c})=>(
                <div key={label} className="p-3 rounded-xl text-center" style={{background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.06)'}}>
                  <div className="text-base mb-1">{icon}</div>
                  <div className="text-lg font-bold" style={{color:c}}>{val}</div>
                  <div className="text-[10px] text-zinc-600">{label}</div>
                </div>
              ))}
            </div>
            <div className="p-3 rounded-xl mb-4 text-[11px] text-zinc-500 space-y-1" style={{background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.05)'}}>
              {[
                {icon:'✅', text:'project.db — projects, epics, tasks, model stats, chat sessions'},
                {icon:'✅', text:'agent_memory.db — agent history, reflection scores, error patterns'},
                {icon:'✅', text:'providers.json — API keys &amp; cloud model list (atomic write)'},
                {icon:'✅', text:'session-memory.json — best practices &amp; agent learnings (atomic write)'},
                {icon:'✅', text:'WAL journal mode — safe concurrent reads during writes'},
              ].map(({icon,text},i)=>(
                <div key={i} className="flex items-center gap-2">
                  <span>{icon}</span>
                  <span dangerouslySetInnerHTML={{__html:text}}/>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <button onClick={runBackup} disabled={backing}
                className="px-4 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-40 flex items-center gap-2"
                style={{background:'rgba(16,185,129,0.12)',color:'#34d399',border:'1px solid rgba(16,185,129,0.2)'}}>
                <span>{backing?'⏳':'💾'}</span>{backing?'Backing up...':'Backup Now'}
              </button>
              {backupMsg && <span className="text-[11px]" style={{color:backupMsg.startsWith('✅')?'#34d399':'#f59e0b'}}>{backupMsg}</span>}
            </div>
            {backupFiles.length>0 && (
              <div className="mt-4">
                <p className="text-[10px] text-zinc-700 mb-2 uppercase tracking-widest">Recent backup files</p>
                <div className="space-y-1 max-h-40 overflow-y-auto forge-scroll">
                  {backupFiles.slice(0,10).map(f=>(
                    <div key={f.name} className="flex items-center gap-3 py-1 px-2 rounded-lg text-[11px]" style={{background:'rgba(255,255,255,0.02)'}}>
                      <span className="text-zinc-600 flex-1 truncate font-mono">{f.name}</span>
                      <span className="text-zinc-700 flex-shrink-0">{f.size>1024*1024?`${(f.size/1024/1024).toFixed(1)}MB`:`${(f.size/1024).toFixed(0)}KB`}</span>
                      <span className="text-zinc-700 flex-shrink-0">{new Date(f.mtime).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })()}

    </div>
  )
}

// ── Sessions Panel ─────────────────────────────────────────────────────────
function SessionsPanel({ onOpenChat }) {
  const [sessions, setSessions] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [search, setSearch] = React.useState('')
  const [deleting, setDeleting] = React.useState(null)
  const [selected, setSelected] = React.useState(null)  // preview
  const [msgs, setMsgs] = React.useState([])

  const load = async () => {
    setLoading(true)
    const d = await apiFetch('/chat/sessions').catch(() => null)
    if (Array.isArray(d)) setSessions(d)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const del = async (id, e) => {
    e.stopPropagation()
    setDeleting(id)
    await fetch(`/chat/sessions/${id}`, { method: 'DELETE' }).catch(() => {})
    setSessions(s => s.filter(x => x.id !== id))
    if (selected?.id === id) { setSelected(null); setMsgs([]) }
    setDeleting(null)
  }

  const preview = async (s) => {
    if (selected?.id === s.id) { setSelected(null); setMsgs([]); return }
    setSelected(s)
    const d = await apiFetch(`/chat/sessions/${s.id}`).catch(() => null)
    if (d?.messages) try { setMsgs(JSON.parse(d.messages)) } catch { setMsgs([]) }
    else setMsgs([])
  }

  const filtered = sessions.filter(s =>
    !search || s.title?.toLowerCase().includes(search.toLowerCase())
  )

  const totalMsgs = sessions.reduce((a, s) => a + (s.message_count || 0), 0)
  const models = [...new Set(sessions.map(s => s.model).filter(Boolean))]

  return (
    <div className="space-y-4">
      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Saved Sessions', val: sessions.length, icon: '💬', color: '#a78bfa' },
          { label: 'Total Messages', val: totalMsgs, icon: '📨', color: '#60a5fa' },
          { label: 'Models Used', val: models.length, icon: '🤖', color: '#34d399' },
        ].map(({ label, val, icon, color: c }) => (
          <div key={label} className="forge-card text-center py-3">
            <div className="text-lg mb-0.5">{icon}</div>
            <div className="text-xl font-bold" style={{ color: c }}>{val}</div>
            <div className="text-[10px] text-zinc-600">{label}</div>
          </div>
        ))}
      </div>

      {/* Search + list */}
      <div className="forge-card">
        <div className="flex items-center gap-3 mb-4">
          <History size={13} className="text-violet-400"/>
          <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-widest flex-1">Chat History</h3>
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-white/5 transition-colors">
            <RefreshCw size={11} className="text-zinc-600"/>
          </button>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600"/>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search sessions..."
            className="w-full pl-8 pr-3 py-2 rounded-lg text-xs bg-white/[0.03] border border-white/[0.06] text-zinc-300 placeholder-zinc-700 outline-none focus:border-violet-500/40"/>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_,i)=>(
              <div key={i} className="h-16 rounded-xl animate-pulse" style={{background:'rgba(255,255,255,0.025)'}}/>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <History size={28} className="text-zinc-700 mx-auto mb-2"/>
            <p className="text-zinc-500 text-sm">{search ? 'No sessions match your search' : 'No saved sessions yet'}</p>
            <p className="text-zinc-700 text-xs mt-1">{search ? '' : 'Use the 💾 Save button in Chat to save a conversation'}</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filtered.map(s => {
              const isOpen = selected?.id === s.id
              const modelColor = MODEL_META[s.model]?.color || '#71717a'
              const date = s.created_at ? new Date(s.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'
              const time = s.created_at ? new Date(s.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''
              return (
                <div key={s.id}>
                  <div onClick={() => preview(s)} className="flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer hover:bg-white/[0.04] transition-colors"
                    style={{ background: isOpen ? 'rgba(124,58,237,0.08)' : 'rgba(255,255,255,0.02)', border: isOpen ? '1px solid rgba(124,58,237,0.2)' : '1px solid rgba(255,255,255,0.04)' }}>
                    {/* Color dot */}
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: modelColor }}/>
                    {/* Title + meta */}
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-zinc-300 truncate">{s.title || 'Untitled'}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-zinc-600">{date} {time}</span>
                        {s.model && <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: modelColor + '15', color: modelColor }}>{s.model.split(':')[0]}</span>}
                        {s.message_count > 0 && <span className="text-[10px] text-zinc-700">{s.message_count} msgs</span>}
                      </div>
                    </div>
                    {/* Actions */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {onOpenChat && (
                        <button onClick={e => { e.stopPropagation(); onOpenChat(s) }}
                          className="p-1.5 rounded-lg hover:bg-violet-500/15 transition-colors" title="Resume in Chat">
                          <MessageSquare size={11} className="text-violet-400"/>
                        </button>
                      )}
                      <button onClick={e => del(s.id, e)} disabled={deleting === s.id}
                        className="p-1.5 rounded-lg hover:bg-red-500/15 transition-colors" title="Delete">
                        {deleting === s.id
                          ? <RefreshCw size={11} className="text-zinc-600 animate-spin"/>
                          : <X size={11} className="text-zinc-600 hover:text-red-400"/>}
                      </button>
                    </div>
                  </div>

                  {/* Inline preview */}
                  {isOpen && msgs.length > 0 && (
                    <div className="mx-2 mb-1.5 p-3 rounded-b-xl space-y-2 max-h-80 overflow-y-auto forge-scroll"
                      style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(124,58,237,0.15)', borderTop: 'none' }}>
                      {msgs.filter(m => m.role === 'user' || m.role === 'assistant').map((m, i) => (
                        <div key={i} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                          <div className="max-w-[80%] px-3 py-2 rounded-xl text-[11px] leading-relaxed"
                            style={{ background: m.role === 'user' ? 'rgba(124,58,237,0.2)' : 'rgba(255,255,255,0.04)', color: m.role === 'user' ? '#c4b5fd' : '#a1a1aa', border: `1px solid ${m.role === 'user' ? 'rgba(124,58,237,0.3)' : 'rgba(255,255,255,0.06)'}` }}>
                            {(m.content || '').slice(0, 300)}{m.content?.length > 300 ? '…' : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Models used */}
      {models.length > 0 && (
        <div className="forge-card">
          <div className="flex items-center gap-2 mb-3">
            <Cpu size={12} className="text-zinc-500"/>
            <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">Models in History</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {models.map(m => {
              const c = MODEL_META[m]?.color || '#71717a'
              const count = sessions.filter(s => s.model === m).length
              return (
                <div key={m} className="flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px]"
                  style={{ background: c + '15', border: `1px solid ${c}30`, color: c }}>
                  <span className="font-medium">{m.split(':')[0]}</span>
                  <span className="opacity-60">{count}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [tab,setTab]=useState('overview')
  const [projects,setProjects]=useState([])
  const [mobile,setMobile]=useState(false)
  const [running,setRunning]=useState(false)
  const loadP=useCallback(async()=>{ const d=await apiFetch('/projects'); if(Array.isArray(d)) setProjects(d) },[])
  useEffect(()=>{ loadP(); const iv=setInterval(loadP,8000); return()=>clearInterval(iv) },[loadP])
  useEffect(()=>{
    const check=()=>apiFetch('/runner/status').then(d=>{ if(d) setRunning(!!d.running) })
    check(); const iv=setInterval(check,5000); return()=>clearInterval(iv)
  },[])
  useEffect(()=>{ const c=()=>setMobile(window.innerWidth<768); c(); window.addEventListener('resize',c); return()=>window.removeEventListener('resize',c) },[])
  const runProject=async(id)=>{ await fetch(`/project/${id}/auto-run`,{method:'POST'}).catch(()=>{}); setTimeout(loadP,1000) }
  return (
    <div className="forge-root">
      <div className="forge-bg">
        <Aurora colorStops={['#0d0018','#000a14','#001209']} amplitude={0.55} blend={0.75} speed={0.2}/>
      </div>
      <div className="forge-shell">
        {!mobile && <Sidebar tab={tab} setTab={setTab} projects={projects} running={running}/>}
        <div className="forge-body">
          {mobile && (
            <nav className="flex gap-1.5 px-3 pt-3 overflow-x-auto forge-scroll">
              {NAV.map(({id,Icon,label})=>(
                <button key={id} onClick={()=>setTab(id)} className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all flex items-center gap-1.5 ${tab===id?'bg-violet-500/15 text-violet-200 border-violet-500/25':'text-zinc-500 border-white/[0.06]'}`}>
                  <Icon size={11}/>{label}
                </button>
              ))}
            </nav>
          )}
          <main className="forge-main">
            {tab==='overview' &&<Overview projects={projects} onRun={runProject}/>}
            {tab==='pipeline' &&<Pipeline projects={projects}/>}
            {tab==='chat'     &&<Chat onSwitchToSessions={()=>setTab('sessions')}/>}
            {tab==='sessions' &&<SessionsPanel onOpenChat={(s)=>{ setTab('chat') }}/>}
            {tab==='models'   &&<Models/>}
            {tab==='settings' &&<Settings/>}
          </main>
        </div>
      </div>
      <ActivityFeed/>
    </div>
  )
}
