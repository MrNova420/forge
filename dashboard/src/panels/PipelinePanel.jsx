import { useState, useEffect, useRef, useCallback } from 'react'
import SpotlightCard from '../components/SpotlightCard/SpotlightCard'
import { Play, Zap, StopCircle, RefreshCw, Terminal, CheckCircle, Clock, AlertCircle, RotateCcw } from 'lucide-react'

const STAGES = ['research','architect','coder','refactor','tester','reviewer','debugger','security','docs']
const STAGE_LABELS = { research:'Research', architect:'Architect', coder:'Code', refactor:'Refactor', tester:'Test', reviewer:'Review', debugger:'Debug', security:'Security', docs:'Docs' }
const AGENT_TO_STAGE = { researcher:'research', architect:'architect', coder:'code', refactor:'refactor', tester:'test', reviewer:'review', debugger:'debug', security:'security', docs:'docs' }

function StageBar({ currentStage, completedStages }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:0, overflowX:'auto', padding:'4px 0', flexWrap:'nowrap' }}>
      {STAGES.map((s, i) => {
        const label = STAGE_LABELS[s]
        const done = completedStages.includes(s)
        const active = currentStage === s || currentStage === AGENT_TO_STAGE[s]
        return (
          <div key={s} style={{ display:'flex', alignItems:'center' }}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
              <div style={{ width:28, height:28, borderRadius:'50%',
                background: done ? '#10b981' : active ? '#7c3aed' : '#0a0a0f',
                border:`2px solid ${done ? '#10b981' : active ? '#7c3aed' : '#2d2d3e'}`,
                display:'flex', alignItems:'center', justifyContent:'center',
                fontSize:11, fontWeight:700,
                color: done||active ? '#fff' : '#64748b',
                boxShadow: active ? '0 0 14px #7c3aedaa' : 'none',
                transition:'all 0.3s', flexShrink:0 }}>
                {done ? '✓' : i+1}
              </div>
              <span style={{ fontSize:9, whiteSpace:'nowrap', fontWeight: active ? 700 : 400,
                color: active ? '#a78bfa' : done ? '#10b981' : '#4a5568' }}>{label}</span>
            </div>
            {i < STAGES.length-1 && <div style={{ width:18, height:2, marginBottom:20, flexShrink:0, transition:'background 0.3s',
              background: done ? '#10b981' : active ? '#7c3aed44' : '#1e1e2e' }} />}
          </div>
        )
      })}
    </div>
  )
}

function TaskRow({ t }) {
  const score = typeof t.quality_score === 'number' ? t.quality_score : (typeof t.score === 'number' ? t.score : null)
  const status = t.status || 'pending'
  const title = t.title || t.name || t.id || '—'
  return (
    <div style={{ background:'#0a0a0f', border:'1px solid #1e1e2e', borderRadius:8, padding:'8px 12px', display:'flex', alignItems:'center', gap:10 }}>
      <div style={{ flexShrink:0 }}>
        {status==='done' ? <CheckCircle size={15} color="#10b981" />
          : status==='in_progress'||status==='running' ? <RefreshCw size={15} color="#3b82f6" style={{ animation:'spin 1s linear infinite' }} />
          : status==='failed' ? <AlertCircle size={15} color="#ef4444" />
          : <Clock size={15} color="#334155" />}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:13, color: status==='done' ? '#94a3b8' : '#e2e8f0', fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{title}</div>
        {t.currentStage && <div style={{ fontSize:10, color:'#7c3aed', marginTop:2 }}>▶ {STAGE_LABELS[t.currentStage] || t.currentStage}</div>}
      </div>
      {score !== null && (
        <div style={{ fontSize:12, padding:'2px 7px', borderRadius:20, fontWeight:700, flexShrink:0,
          background: score>=8?'#10b98118':score>=6?'#f59e0b18':'#ef444418',
          color: score>=8?'#10b981':score>=6?'#f59e0b':'#ef4444',
          border:`1px solid ${score>=8?'#10b98144':score>=6?'#f59e0b44':'#ef444444'}` }}>
          {score}/10
        </div>
      )}
    </div>
  )
}

export default function PipelinePanel({ api }) {
  const [project, setProject] = useState(null)
  const [tasks, setTasks] = useState([])
  const [autoRunning, setAutoRunning] = useState(false)
  const [currentStage, setCurrentStage] = useState('')
  const [completedStages, setCompletedStages] = useState([])
  const [currentTask, setCurrentTask] = useState('')
  const [progress, setProgress] = useState({ done:0, total:0 })
  const [events, setEvents] = useState([])
  const [taskStages, setTaskStages] = useState({}) // taskId -> currentStage
  const logRef = useRef(null)
  const esRef = useRef(null)

  const addEvent = (msg, type='info') => {
    const time = new Date().toLocaleTimeString()
    setEvents(prev => [...prev.slice(-299), { msg, time, type }])
    setTimeout(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, 50)
  }

  const fetchProject = useCallback(async () => {
    try {
      const data = await fetch(`${api}/projects/overview`).then(r=>r.json()).catch(()=>({}))
      const ps = data.projects || []
      // Find the most recently active/running project
      const active = ps.find(p => p.doneTasks < p.taskCount && p.taskCount > 0) || ps[0]
      if (!active) return
      setProject(active)
      setProgress({ done: active.doneTasks||0, total: active.taskCount||0 })

      // Also check auto-run status
      const st = await fetch(`${api}/project/${active.id}/auto-run/status`).then(r=>r.json()).catch(()=>({}))
      setAutoRunning(!!st.running)

      // Fetch full task list
      const full = await fetch(`${api}/projects/${active.id}`).then(r=>r.json()).catch(()=>({}))
      const allTasks = (full.epics||[]).flatMap(e => e.tasks||[])
      setTasks(allTasks)
      setProgress({ done: allTasks.filter(t=>t.status==='done').length, total: allTasks.length })
    } catch {}
  }, [api])

  useEffect(() => {
    fetchProject()
    const poll = setInterval(() => { if (document.visibilityState !== 'hidden') fetchProject() }, 4000)

    const es = new EventSource(`${api}/events`)
    esRef.current = es
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        const type = d.type || ''

        if (type === 'agent') {
          // { type:'agent', agent:'coder', task:'...', status:'running'|'done' }
          const stageName = d.agent || ''
          if (d.status === 'running') {
            setCurrentStage(stageName)
            setCompletedStages(prev => prev.filter(s => s !== stageName))
            if (d.task) setCurrentTask(d.task)
            if (d.taskId) setTaskStages(prev => ({ ...prev, [d.taskId]: stageName }))
            addEvent(`▶ ${STAGE_LABELS[stageName]||stageName}: ${(d.task||'').slice(0,60)}`, 'info')
          } else if (d.status === 'done') {
            setCompletedStages(prev => [...new Set([...prev, stageName])])
          }
        } else if (type === 'pipeline_stage') {
          // { type:'pipeline_stage', role:'coder', status:'done', score, taskId }
          const role = d.role || ''
          if (d.status === 'done') {
            setCompletedStages(prev => [...new Set([...prev, role])])
            if (d.score != null) addEvent(`✓ ${STAGE_LABELS[role]||role} done — score: ${d.score}/10`, 'success')
          }
        } else if (type === 'task_start') {
          // { taskId, title, gpuTemp }
          setCurrentTask(d.title || '')
          setCompletedStages([]) // reset stage bar for new task
          setCurrentStage('research')
          addEvent(`⚡ Task: ${(d.title||'').slice(0,70)}`, 'success')
        } else if (type === 'auto_run_task') {
          setProgress({ done: d.done||0, total: d.total||0 })
          setCurrentTask(d.title||'')
          addEvent(`[${d.done}/${d.total}] ${(d.title||'').slice(0,60)}`, 'info')
        } else if (type === 'auto_run_done') {
          const score = d.score
          setProgress(prev => ({ ...prev, done: d.done||prev.done }))
          addEvent(`✅ Done — score: ${score}/10`, score>=7?'success':'warning')
          fetchProject()
        } else if (type === 'auto_run_complete') {
          setAutoRunning(false)
          setCurrentStage('')
          addEvent('🏁 All tasks complete!', 'success')
          fetchProject()
        } else if (type === 'build_start') {
          addEvent(`🔨 Build started: ${d.name||''}`, 'success')
          fetchProject()
        } else if (d.message) {
          addEvent(d.message, 'info')
        }
      } catch {}
    }
    es.onerror = () => {}
    return () => { clearInterval(poll); es.close() }
  }, [api, fetchProject])

  const startAutoRun = async () => {
    if (!project) return
    try {
      await fetch(`${api}/project/${project.id}/auto-run`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ maxFails:5 }) })
      setAutoRunning(true)
      addEvent(`🚀 Auto-run started for "${project.name}"`, 'success')
    } catch(e) { addEvent(`Error: ${e.message}`, 'error') }
  }

  const stopAutoRun = async () => {
    if (!project) return
    try {
      await fetch(`${api}/project/${project.id}/auto-run/stop`, { method:'POST' })
      setAutoRunning(false)
      addEvent('⛔ Auto-run stopped', 'warning')
    } catch(e) { addEvent(`Error: ${e.message}`, 'error') }
  }

  const runNext = async () => {
    try {
      const r = await fetch(`${api}/task/run-next`, { method:'POST' }).then(d=>d.json())
      if (r.error) addEvent(`Error: ${r.error}`, 'error')
      else addEvent(`Running: ${(r.title||r.message||'next task').slice(0,60)}`, 'success')
      fetchProject()
    } catch(e) { addEvent(`Error: ${e.message}`, 'error') }
  }

  const resetMutex = async () => {
    try {
      const r = await fetch(`${api}/mutex/reset`, { method:'POST' }).then(d=>d.json())
      addEvent(`Mutex reset: ${r.msg||'done'}`, 'warning')
      fetchProject()
    } catch {}
  }

  const pct = progress.total > 0 ? Math.round((progress.done/progress.total)*100) : 0
  const pendingCount = tasks.filter(t=>t.status==='pending').length
  const inProgressCount = tasks.filter(t=>t.status==='in_progress'||t.status==='running').length
  const doneCount = tasks.filter(t=>t.status==='done').length

  return (
    <div style={{ paddingBottom:100, display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>
      {/* Left column */}
      <div style={{ display:'flex', flexDirection:'column', gap:20 }}>

        {/* Project + controls */}
        <SpotlightCard spotlightColor="#7c3aed33">
          <div style={{ background:'#111118', border:'1px solid #1e1e2e', borderRadius:12, padding:20 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:12 }}>
              <div>
                <h3 style={{ fontSize:16, fontWeight:700, color:'#e2e8f0', marginBottom:2 }}>{project?.name||'No active project'}</h3>
                {currentTask && <div style={{ fontSize:11, color:'#7c3aed', fontWeight:500 }}>▶ {currentTask.slice(0,60)}</div>}
              </div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap', justifyContent:'flex-end' }}>
                <button onClick={runNext} title="Run one task" style={{ background:'#1e1e2e', border:'1px solid #2d2d3e', borderRadius:7, padding:'5px 10px', color:'#94a3b8', fontSize:12, cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
                  <Play size={11} /> Run 1
                </button>
                {autoRunning ? (
                  <button onClick={stopAutoRun} style={{ background:'#ef444422', border:'1px solid #ef444444', borderRadius:7, padding:'5px 10px', color:'#ef4444', fontSize:12, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
                    <StopCircle size={11} /> Stop
                  </button>
                ) : (
                  <button onClick={startAutoRun} style={{ background:'#7c3aed22', border:'1px solid #7c3aed44', borderRadius:7, padding:'5px 10px', color:'#a78bfa', fontSize:12, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
                    <Zap size={11} /> Auto Run
                  </button>
                )}
                <button onClick={resetMutex} title="Unstick pipeline" style={{ background:'#1e1e2e', border:'1px solid #2d2d3e', borderRadius:7, padding:'5px 10px', color:'#64748b', fontSize:12, cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
                  <RotateCcw size={11} /> Reset
                </button>
              </div>
            </div>

            {/* Progress bar */}
            {progress.total > 0 && (
              <div style={{ marginBottom:14 }}>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'#64748b', marginBottom:4 }}>
                  <span style={{ color: autoRunning ? '#10b981' : '#64748b' }}>{autoRunning ? '● Running' : '○ Idle'}</span>
                  <span style={{ color:'#94a3b8', fontWeight:600 }}>{progress.done}/{progress.total} tasks ({pct}%)</span>
                </div>
                <div style={{ height:6, background:'#1e1e2e', borderRadius:3, overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${pct}%`, background:'linear-gradient(90deg, #7c3aed, #3b82f6)', borderRadius:3, transition:'width 0.5s' }} />
                </div>
                <div style={{ display:'flex', gap:12, marginTop:6, fontSize:11 }}>
                  <span style={{ color:'#10b981' }}>✓ {doneCount} done</span>
                  {inProgressCount > 0 && <span style={{ color:'#3b82f6' }}>⚡ {inProgressCount} running</span>}
                  {pendingCount > 0 && <span style={{ color:'#64748b' }}>○ {pendingCount} pending</span>}
                </div>
              </div>
            )}

            {/* Stage bar */}
            <StageBar currentStage={currentStage} completedStages={completedStages} />
          </div>
        </SpotlightCard>

        {/* Task list */}
        <div style={{ background:'#111118', border:'1px solid #1e1e2e', borderRadius:12, padding:'16px 20px', flex:1 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
            <h3 style={{ fontSize:14, fontWeight:600, color:'#e2e8f0' }}>Tasks</h3>
            <button onClick={fetchProject} style={{ background:'none', border:'none', color:'#64748b', cursor:'pointer', fontSize:11, display:'flex', alignItems:'center', gap:4 }}>
              <RefreshCw size={11} /> refresh
            </button>
          </div>
          {tasks.length === 0 ? (
            <div style={{ color:'#334155', textAlign:'center', padding:'24px 0', fontSize:13 }}>No tasks — create a project in Chat</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:6, maxHeight:500, overflowY:'auto' }}>
              {tasks.map(t => <TaskRow key={t.id} t={{ ...t, currentStage: t.status==='in_progress' ? (taskStages[t.id]||currentStage) : undefined }} />)}
            </div>
          )}
        </div>
      </div>

      {/* Right column: live log */}
      <div style={{ background:'#111118', border:'1px solid #1e1e2e', borderRadius:12, padding:20, display:'flex', flexDirection:'column' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
          <Terminal size={15} color="#7c3aed" />
          <h3 style={{ fontSize:14, fontWeight:600, color:'#e2e8f0' }}>Live Log</h3>
          <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>
            {autoRunning && <div style={{ width:6, height:6, borderRadius:'50%', background:'#10b981', animation:'pulse 1.5s infinite' }} />}
            <span style={{ fontSize:10, color: autoRunning ? '#10b981' : '#334155' }}>{autoRunning ? 'running' : 'idle'}</span>
            <button onClick={()=>setEvents([])} style={{ background:'none', border:'none', color:'#334155', cursor:'pointer', fontSize:10 }}>clear</button>
          </div>
        </div>
        <div ref={logRef} style={{ flex:1, overflowY:'auto', fontFamily:'monospace', fontSize:11.5, background:'#0a0a0f', borderRadius:8, padding:'10px 12px', minHeight:480, display:'flex', flexDirection:'column', gap:2 }}>
          {events.length === 0 ? (
            <div style={{ color:'#334155', textAlign:'center', paddingTop:24 }}>Waiting for pipeline events...</div>
          ) : events.map((e,i) => (
            <div key={i} style={{ display:'flex', gap:8, lineHeight:1.5 }}>
              <span style={{ color:'#334155', flexShrink:0 }}>{e.time}</span>
              <span style={{ color: e.type==='error'?'#ef4444':e.type==='success'?'#10b981':e.type==='warning'?'#f59e0b':'#64748b' }}>{e.msg}</span>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
      `}</style>
    </div>
  )
}
