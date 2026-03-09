import { useState, useEffect, useCallback } from 'react'
import { Cpu, RefreshCw, Zap, Database } from 'lucide-react'

const TIER_COLORS = {
  'Coder': '#3b82f6', 'Planner': '#8b5cf6', 'General': '#9333ea',
  'Custom': '#db2777', 'Auditor': '#f59e0b', 'Unknown': '#71717a'
}

function fmtSize(bytes) {
  if (!bytes) return '?'
  const gb = bytes / 1024 / 1024 / 1024
  return gb >= 1 ? gb.toFixed(1) + ' GB' : (bytes / 1024 / 1024).toFixed(0) + ' MB'
}

function ModelCard({ model, loadedInfo }) {
  const isLoaded = !!loadedInfo
  const vramBytes = loadedInfo?.vram || 0
  const color = TIER_COLORS[model.tier] || '#71717a'

  return (
    <div style={{
      background: '#0f0f17', border: `1px solid ${isLoaded ? color + '55' : '#1e1e2e'}`,
      borderRadius: '12px', padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px',
      transition: 'border-color 0.3s'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0', wordBreak: 'break-all', lineHeight: 1.3 }}>
            {model.name}
          </div>
          {model.role && (
            <div style={{ fontSize: '11px', color: '#64748b', marginTop: '3px' }}>{model.role}</div>
          )}
        </div>
        <span style={{
          fontSize: '11px', padding: '3px 10px', borderRadius: '20px', flexShrink: 0,
          background: isLoaded ? color + '22' : '#1e1e2e',
          color: isLoaded ? color : '#64748b',
          border: `1px solid ${isLoaded ? color + '44' : '#2d2d3e'}`
        }}>
          {isLoaded ? '● hot' : '○ cold'}
        </span>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <div style={{ background: '#0a0a0f', borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '2px' }}>Size</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: '#e2e8f0' }}>{fmtSize(model.size)}</div>
        </div>
        <div style={{ background: '#0a0a0f', borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '2px' }}>VRAM live</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: isLoaded ? '#10b981' : '#334155' }}>
            {isLoaded ? fmtSize(vramBytes) : '—'}
          </div>
        </div>
        <div style={{ background: '#0a0a0f', borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '2px' }}>Tok/s</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: '#3b82f6' }}>
            {model.avgToksPerSec ? model.avgToksPerSec.toFixed(1) : '—'}
          </div>
        </div>
        <div style={{ background: '#0a0a0f', borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '2px' }}>Calls</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: '#8b5cf6' }}>
            {model.totalCalls || 0}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ModelsPanel({ api }) {
  const [models, setModels] = useState([])
  const [loadedMap, setLoadedMap] = useState({}) // name -> {vram}
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const fetchData = useCallback(async () => {
    try {
      const [modR, vramR, statsR] = await Promise.all([
        fetch(`${api}/models`).then(r => r.json()).catch(() => ({})),
        fetch(`${api}/vram/status`).then(r => r.json()).catch(() => ({})),
        fetch(`${api}/stats/models`).then(r => r.json()).catch(() => ({})),
      ])

      // Build loaded map: name -> {vram}
      const loaded = {}
      const vramLoaded = Array.isArray(vramR?.loaded) ? vramR.loaded : []
      vramLoaded.forEach(entry => {
        const name = typeof entry === 'string' ? entry : entry?.name
        if (name) loaded[name] = { vram: entry?.vram || 0 }
      })
      setLoadedMap(loaded)

      // Build stats map: name -> {avgToksPerSec, totalCalls}
      const statsArr = Array.isArray(statsR?.models) ? statsR.models : []
      const statsMap = {}
      statsArr.forEach(s => { if (s.model) statsMap[s.model] = s })

      // Role map from vram/status
      const roleMap = {}
      const rolesArr = Array.isArray(vramR?.roles) ? vramR.roles : []
      rolesArr.forEach(r => { if (r?.model && !roleMap[r.model]) roleMap[r.model] = r.role })

      // Build model list from /models (source of truth)
      const raw = Array.isArray(modR?.models) ? modR.models : []
      const list = raw.map(m => {
        const st = statsMap[m.name] || {}
        return {
          name: m.name,
          size: m.size || 0,
          role: roleMap[m.name] || '',
          avgToksPerSec: st.avg_tok_per_sec || 0,
          totalCalls: st.total_calls || 0,
        }
      }).sort((a, b) => a.size - b.size)

      setModels(list)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [api])

  useEffect(() => {
    fetchData()
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') fetchData()
    }, 5000)
    return () => clearInterval(t)
  }, [fetchData])

  const refresh = async () => {
    setLoading(true)
    await fetch(`${api}/vram/refresh-models`, { method: 'POST' }).catch(() => {})
    await fetchData()
    setLoading(false)
  }

  const hotCount = Object.keys(loadedMap).length
  const totalVram = Object.values(loadedMap).reduce((s, m) => s + (m.vram || 0), 0)

  return (
    <div style={{ paddingBottom: '80px' }}>
      {/* Header bar */}
      <div style={{
        background: '#0f0f17', border: '1px solid #1e1e2e', borderRadius: '12px',
        padding: '16px 20px', marginBottom: '20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Cpu size={18} color="#7c3aed" />
            <span style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>
              Model Fleet — {models.length} installed
            </span>
          </div>
          {hotCount > 0 && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {Object.keys(loadedMap).map(name => (
                <span key={name} style={{
                  fontSize: '11px', padding: '2px 8px', borderRadius: '20px',
                  background: '#10b98122', color: '#10b981', border: '1px solid #10b98144'
                }}>● {name}</span>
              ))}
            </div>
          )}
          {totalVram > 0 && (
            <span style={{ fontSize: '12px', color: '#64748b' }}>
              {fmtSize(totalVram)} in VRAM
            </span>
          )}
        </div>
        <button onClick={refresh} disabled={loading} style={{
          background: '#7c3aed22', border: '1px solid #7c3aed44', borderRadius: '8px',
          padding: '7px 14px', color: '#7c3aed', fontSize: '13px', fontWeight: 600,
          cursor: loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
          opacity: loading ? 0.6 : 1
        }}>
          <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ background: '#7f1d1d22', border: '1px solid #7f1d1d', borderRadius: '8px', padding: '12px', marginBottom: '16px', color: '#fca5a5', fontSize: '13px' }}>
          Error: {error}
        </div>
      )}

      {models.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#64748b', padding: '60px 20px', background: '#0f0f17', borderRadius: '12px', border: '1px solid #1e1e2e' }}>
          <Cpu size={36} color="#1e1e2e" style={{ margin: '0 auto 12px', display: 'block' }} />
          <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '6px' }}>No models found</div>
          <div style={{ fontSize: '13px' }}>Click Refresh to scan Ollama for installed models</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
          {models.map(m => <ModelCard key={m.name} model={m} loadedInfo={loadedMap[m.name] || null} />)}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
