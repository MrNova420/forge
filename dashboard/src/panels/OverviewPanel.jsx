import { useState, useEffect, useCallback } from 'react'
import SpotlightCard from '../components/SpotlightCard/SpotlightCard'
import AnimatedList from '../components/AnimatedList/AnimatedList'
import CountUp from '../components/CountUp/CountUp'
import { Zap, CheckCircle, Star, Cpu, Plus, Play, RefreshCw } from 'lucide-react'

const cardStyle = {
  background: '#111118',
  border: '1px solid #1e1e2e',
  borderRadius: '12px',
  padding: '24px',
  height: '100%',
}

function StatCard({ icon: Icon, label, value, unit = '', color = '#7c3aed' }) {
  return (
    <SpotlightCard spotlightColor={`${color}33`} style={{ height: '100%' }}>
      <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ background: `${color}22`, borderRadius: '8px', padding: '8px', display: 'flex' }}>
            <Icon size={18} color={color} />
          </div>
          <span style={{ color: '#64748b', fontSize: '13px', fontWeight: 500 }}>{label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
          <span style={{ fontSize: '36px', fontWeight: '700', color: '#e2e8f0', lineHeight: 1 }}>
            <CountUp to={typeof value === 'number' ? value : 0} from={0} duration={1.5} separator="," />
          </span>
          {unit && <span style={{ color: '#64748b', fontSize: '14px' }}>{unit}</span>}
        </div>
      </div>
    </SpotlightCard>
  )
}

export default function OverviewPanel({ api }) {
  const [stats, setStats] = useState(null)
  const [projects, setProjects] = useState([])
  const [buildName, setBuildName] = useState('')
  const [buildDesc, setBuildDesc] = useState('')
  const [building, setBuilding] = useState(false)
  const [buildMsg, setBuildMsg] = useState('')
  const [health, setHealth] = useState(null)

  const fetchData = useCallback(async () => {
    try {
      const [s, p, h] = await Promise.all([
        fetch(`${api}/stats`).then(r => r.json()).catch(() => null),
        fetch(`${api}/projects/overview`).then(r => r.json()).catch(() => []),
        fetch(`${api}/health`).then(r => r.json()).catch(() => null),
      ])
      setStats(s)
      setProjects(Array.isArray(p) ? p : [])
      setHealth(h)
    } catch(e) {}
  }, [api])

  useEffect(() => {
    fetchData()
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') fetchData() }, 5000)
    return () => clearInterval(t)
  }, [fetchData])

  const handleBuild = async () => {
    if (!buildName.trim()) return
    setBuilding(true)
    setBuildMsg('')
    try {
      const r = await fetch(`${api}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: buildName, description: buildDesc })
      })
      const data = await r.json()
      setBuildMsg(data.message || data.error || 'Project created!')
      setBuildName('')
      setBuildDesc('')
      fetchData()
    } catch(e) {
      setBuildMsg('Error: ' + e.message)
    }
    setBuilding(false)
  }

  const handleRun = async (projectId) => {
    try {
      await fetch(`${api}/project/${projectId}/auto-run`, { method: 'POST' })
      setBuildMsg(`Running project ${projectId}...`)
    } catch(e) {}
  }

  const totalProjects = stats?.projects ?? projects.length ?? 0
  const tasksDone = stats?.tasks?.done ?? 0
  const avgScore = typeof stats?.avgQualityScore === 'number' ? Math.round(stats.avgQualityScore * 10) / 10 : 0
  const activeModel = health?.model ?? 'Unknown'

  const listItems = projects.slice(0, 8).map(p => (
    <div key={p.id} style={{ background: '#111118', border: '1px solid #1e1e2e', borderRadius: '10px', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
          <span style={{ fontWeight: 600, fontSize: '14px', color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name || p.id}</span>
          <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '20px', background: p.status === 'done' ? '#10b98122' : p.status === 'running' ? '#3b82f622' : '#64748b22', color: p.status === 'done' ? '#10b981' : p.status === 'running' ? '#3b82f6' : '#64748b', border: `1px solid ${p.status === 'done' ? '#10b98144' : p.status === 'running' ? '#3b82f644' : '#64748b44'}`, flexShrink: 0 }}>{p.status || 'pending'}</span>
        </div>
        <div style={{ display: 'flex', gap: '12px', fontSize: '12px', color: '#64748b' }}>
          {p.taskCounts && <span>✓ {p.taskCounts.done}/{p.taskCounts.total} tasks</span>}
          {p.avgScore !== undefined && <span>★ {p.avgScore}/10</span>}
        </div>
        {p.taskCounts && p.taskCounts.total > 0 && (
          <div style={{ marginTop: '8px', height: '3px', background: '#1e1e2e', borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round((p.taskCounts.done / p.taskCounts.total) * 100)}%`, background: 'linear-gradient(90deg, #7c3aed, #3b82f6)', borderRadius: '2px', transition: 'width 0.5s' }} />
          </div>
        )}
      </div>
      <button onClick={() => handleRun(p.id)} style={{ background: 'linear-gradient(135deg, #7c3aed22, #3b82f622)', border: '1px solid #7c3aed44', borderRadius: '8px', padding: '6px 12px', color: '#7c3aed', fontSize: '12px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap', flexShrink: 0 }}>
        <Play size={12} /> Run
      </button>
    </div>
  ))

  return (
    <div style={{ paddingBottom: '100px' }}>
      {/* Stats Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '24px' }}>
        <StatCard icon={Zap} label="Total Projects" value={totalProjects} color="#7c3aed" />
        <StatCard icon={CheckCircle} label="Tasks Done" value={tasksDone} color="#10b981" />
        <StatCard icon={Star} label="Avg Score" value={avgScore} unit="/10" color="#f59e0b" />
        <div>
          <SpotlightCard spotlightColor="#3b82f633">
            <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ background: '#3b82f622', borderRadius: '8px', padding: '8px', display: 'flex' }}>
                  <Cpu size={18} color="#3b82f6" />
                </div>
                <span style={{ color: '#64748b', fontSize: '13px', fontWeight: 500 }}>Active Model</span>
              </div>
              <div style={{ fontSize: '14px', fontWeight: '600', color: '#e2e8f0', wordBreak: 'break-all' }}>{activeModel}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 6px #10b981' }} />
                <span style={{ fontSize: '12px', color: '#10b981' }}>online</span>
              </div>
            </div>
          </SpotlightCard>
        </div>
      </div>

      {/* Build Form */}
      <div style={{ background: '#111118', border: '1px solid #1e1e2e', borderRadius: '12px', padding: '24px', marginBottom: '24px' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', color: '#e2e8f0' }}>🔨 What do you want to build?</h3>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <input
            value={buildName}
            onChange={e => setBuildName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleBuild()}
            placeholder="Project name..."
            style={{ flex: '1 1 200px', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: '8px', padding: '10px 14px', color: '#e2e8f0', fontSize: '14px', outline: 'none' }}
          />
          <input
            value={buildDesc}
            onChange={e => setBuildDesc(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleBuild()}
            placeholder="Description (optional)..."
            style={{ flex: '2 1 300px', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: '8px', padding: '10px 14px', color: '#e2e8f0', fontSize: '14px', outline: 'none' }}
          />
          <button onClick={handleBuild} disabled={building} style={{ background: building ? '#1e1e2e' : 'linear-gradient(135deg, #7c3aed, #3b82f6)', border: 'none', borderRadius: '8px', padding: '10px 20px', color: '#fff', fontSize: '14px', fontWeight: 600, cursor: building ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
            {building ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={14} />}
            {building ? 'Creating...' : 'Create Project'}
          </button>
        </div>
        {buildMsg && <div style={{ marginTop: '12px', fontSize: '13px', color: buildMsg.startsWith('Error') ? '#ef4444' : '#10b981', padding: '8px 12px', background: buildMsg.startsWith('Error') ? '#ef444411' : '#10b98111', borderRadius: '6px' }}>{buildMsg}</div>}
      </div>

      {/* Projects List */}
      <div style={{ background: '#111118', border: '1px solid #1e1e2e', borderRadius: '12px', padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#e2e8f0' }}>Recent Projects</h3>
          <button onClick={fetchData} style={{ background: 'none', border: '1px solid #1e1e2e', borderRadius: '6px', padding: '6px 10px', color: '#64748b', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        {listItems.length > 0 ? (
          <AnimatedList items={listItems} showGradients={false} enableArrowNavigation={false} displayScrollbar={false} />
        ) : (
          <div style={{ textAlign: 'center', color: '#64748b', padding: '40px', fontSize: '14px' }}>No projects yet. Create your first one above!</div>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
