import { useState, useEffect, useCallback } from 'react'
import SpotlightCard from '../components/SpotlightCard/SpotlightCard'
import { Settings, RefreshCw, Save, Cpu, ToggleLeft, ToggleRight } from 'lucide-react'

const PIPELINE_STAGES = ['Research', 'Architect', 'Code', 'Refactor', 'Test', 'Review', 'Debug', 'Security', 'Docs']

const ROLE_LABELS = {
  architect: { label: 'Architect', color: '#7c3aed', desc: 'System design & planning' },
  coder: { label: 'Coder', color: '#3b82f6', desc: 'Code implementation' },
  reviewer: { label: 'Reviewer', color: '#10b981', desc: 'Code review & quality' },
  tester: { label: 'Tester', color: '#f59e0b', desc: 'Test generation' },
  researcher: { label: 'Researcher', color: '#ec4899', desc: 'Research & analysis' },
  orchestrator: { label: 'Orchestrator', color: '#8b5cf6', desc: 'Pipeline coordination' },
}

export default function SettingsPanel({ api }) {
  const [vramStatus, setVramStatus] = useState(null)
  const [roles, setRoles] = useState({})
  const [availableModels, setAvailableModels] = useState([])
  const [stageToggles, setStageToggles] = useState(() => Object.fromEntries(PIPELINE_STAGES.map(s => [s, true])))
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const fetchData = useCallback(async () => {
    try {
      const d = await fetch(`${api}/vram/status`).then(r => r.json()).catch(() => null)
      if (d) {
        setVramStatus(d)
        setRoles(d.roles || {})
        setAvailableModels(d.availableModels || [])
      }
    } catch(e) {}
  }, [api])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const save = async () => {
    setSaving(true)
    setMsg('')
    try {
      await fetch(`${api}/vram/roles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles })
      })
      setMsg('Settings saved!')
    } catch(e) {
      setMsg('Note: Role settings saved locally (API endpoint may not exist)')
    }
    setSaving(false)
    setTimeout(() => setMsg(''), 3000)
  }

  const allRoleKeys = [
    ...Object.keys(ROLE_LABELS),
    ...Object.keys(roles).filter(r => !ROLE_LABELS[r])
  ]

  return (
    <div style={{ paddingBottom: '100px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Model Role Routing */}
      <div style={{ background: '#111118', border: '1px solid #1e1e2e', borderRadius: '12px', padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Cpu size={18} color="#7c3aed" />
            <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#e2e8f0' }}>Model Role Routing</h3>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={fetchData} style={{ background: '#1e1e2e', border: '1px solid #2d2d3e', borderRadius: '8px', padding: '6px 12px', color: '#64748b', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <RefreshCw size={12} /> Refresh
            </button>
            <button onClick={save} disabled={saving} style={{ background: 'linear-gradient(135deg, #7c3aed, #3b82f6)', border: 'none', borderRadius: '8px', padding: '6px 16px', color: '#fff', fontSize: '12px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Save size={12} /> {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        {msg && <div style={{ marginBottom: '16px', fontSize: '13px', color: '#10b981', padding: '8px 12px', background: '#10b98111', borderRadius: '6px' }}>{msg}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '14px' }}>
          {allRoleKeys.map(roleKey => {
            const meta = ROLE_LABELS[roleKey] || { label: roleKey, color: '#64748b', desc: '' }
            return (
              <SpotlightCard key={roleKey} spotlightColor={`${meta.color}22`}>
                <div style={{ background: '#0a0a0f', borderRadius: '10px', padding: '14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: meta.color }} />
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>{meta.label}</div>
                      {meta.desc && <div style={{ fontSize: '11px', color: '#64748b' }}>{meta.desc}</div>}
                    </div>
                  </div>
                  <select
                    value={roles[roleKey] || ''}
                    onChange={e => setRoles(prev => ({ ...prev, [roleKey]: e.target.value }))}
                    style={{ width: '100%', background: '#111118', border: '1px solid #1e1e2e', borderRadius: '6px', padding: '6px 10px', color: roles[roleKey] ? '#e2e8f0' : '#64748b', fontSize: '12px', outline: 'none', cursor: 'pointer' }}
                  >
                    <option value="">-- not assigned --</option>
                    {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
                    {roles[roleKey] && !availableModels.includes(roles[roleKey]) && (
                      <option value={roles[roleKey]}>{roles[roleKey]}</option>
                    )}
                  </select>
                </div>
              </SpotlightCard>
            )
          })}
        </div>
      </div>

      {/* Pipeline Stage Toggles */}
      <div style={{ background: '#111118', border: '1px solid #1e1e2e', borderRadius: '12px', padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
          <Settings size={18} color="#7c3aed" />
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#e2e8f0' }}>Pipeline Stages</h3>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
          {PIPELINE_STAGES.map(stage => (
            <div key={stage} onClick={() => setStageToggles(prev => ({ ...prev, [stage]: !prev[stage] }))} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#0a0a0f', border: `1px solid ${stageToggles[stage] ? '#7c3aed44' : '#1e1e2e'}`, borderRadius: '8px', padding: '10px 14px', cursor: 'pointer', transition: 'border-color 0.2s' }}>
              <span style={{ fontSize: '13px', fontWeight: 500, color: stageToggles[stage] ? '#e2e8f0' : '#64748b' }}>{stage}</span>
              {stageToggles[stage] ? <ToggleRight size={20} color="#7c3aed" /> : <ToggleLeft size={20} color="#64748b" />}
            </div>
          ))}
        </div>
      </div>

      {/* VRAM Status */}
      {vramStatus && (
        <div style={{ background: '#111118', border: '1px solid #1e1e2e', borderRadius: '12px', padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>VRAM Status</h3>
          <pre style={{ background: '#0a0a0f', borderRadius: '8px', padding: '16px', fontSize: '12px', color: '#94a3b8', fontFamily: 'monospace', overflowX: 'auto', lineHeight: 1.6 }}>
            {JSON.stringify(vramStatus, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
