import { useState, useEffect, useRef, useCallback } from 'react'
import { Send, Zap, Code, HelpCircle, Wrench, Bot, User } from 'lucide-react'

const QUICK_ACTIONS = [
  { label: 'Build me a...', icon: Zap, template: 'Build me a ' },
  { label: 'Explain...', icon: HelpCircle, template: 'Explain how ' },
  { label: 'Fix...', icon: Wrench, template: 'Fix the following: ' },
  { label: 'Write code...', icon: Code, template: 'Write code to ' },
]

function CodeBlock({ code, lang }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div style={{ position: 'relative', margin: '8px 0', background: '#0a0a0f', borderRadius: '8px', border: '1px solid #1e1e2e', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid #1e1e2e', background: '#111118' }}>
        <span style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace' }}>{lang || 'code'}</span>
        <button onClick={copy} style={{ background: 'none', border: 'none', color: copied ? '#10b981' : '#64748b', cursor: 'pointer', fontSize: '11px' }}>{copied ? '✓ Copied' : 'Copy'}</button>
      </div>
      <pre style={{ margin: 0, padding: '12px', fontSize: '12px', overflowX: 'auto', fontFamily: 'monospace', color: '#e2e8f0', lineHeight: 1.6 }}>{code}</pre>
    </div>
  )
}

function MessageContent({ text }) {
  const parts = []
  const re = /```(\w*)\n?([\s\S]*?)```/g
  let last = 0, m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', content: text.slice(last, m.index) })
    parts.push({ type: 'code', lang: m[1], content: m[2] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ type: 'text', content: text.slice(last) })

  return (
    <div>
      {parts.map((p, i) =>
        p.type === 'code'
          ? <CodeBlock key={i} code={p.content} lang={p.lang} />
          : <span key={i} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{p.content}</span>
      )}
    </div>
  )
}

export default function ChatPanel({ api }) {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: "Hello! I'm The Forge AI. What do you want to build today?", model: 'forge' }
  ])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [currentModel, setCurrentModel] = useState('forge')
  const esRef = useRef(null)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    fetch(`${api}/health`).then(r => r.json()).then(d => setCurrentModel(d.model || 'forge')).catch(() => {})
  }, [api])

  const send = useCallback(async (msg) => {
    const text = (msg || input).trim()
    if (!text || streaming) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setStreaming(true)

    try {
      const url = `${api}/chat/stream?message=${encodeURIComponent(text)}`
      const es = new EventSource(url)
      esRef.current = es
      let accumulated = ''
      let modelName = currentModel

      setMessages(prev => [...prev, { role: 'assistant', content: '', model: modelName, streaming: true }])

      es.onmessage = (e) => {
        if (e.data === '[DONE]') {
          es.close()
          setStreaming(false)
          setMessages(prev => prev.map((m, i) => i === prev.length - 1 ? { ...m, streaming: false } : m))
          return
        }
        try {
          const data = JSON.parse(e.data)
          const token = data.token || data.content || data.text || data.chunk || ''
          if (data.model) modelName = data.model
          accumulated += token
          setMessages(prev => prev.map((m, i) => i === prev.length - 1 ? { ...m, content: accumulated, model: modelName } : m))
        } catch {
          accumulated += e.data
          setMessages(prev => prev.map((m, i) => i === prev.length - 1 ? { ...m, content: accumulated } : m))
        }
      }

      es.onerror = async () => {
        es.close()
        try {
          const r = await fetch(`${api}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
          })
          const data = await r.json()
          const reply = data.response || data.message || data.content || JSON.stringify(data)
          setMessages(prev => prev.map((m, i) => i === prev.length - 1 ? { ...m, content: reply, streaming: false, model: data.model || currentModel } : m))
        } catch(ex) {
          setMessages(prev => prev.map((m, i) => i === prev.length - 1 ? { ...m, content: 'Error: Could not reach The Forge API', streaming: false } : m))
        }
        setStreaming(false)
      }
    } catch(e) {
      setStreaming(false)
      setMessages(prev => [...prev, { role: 'assistant', content: 'Error: ' + e.message, model: 'forge' }])
    }
  }, [input, streaming, api, currentModel])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 180px)', minHeight: '500px', background: '#111118', border: '1px solid #1e1e2e', borderRadius: '12px', overflow: 'hidden', marginBottom: '100px' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #1e1e2e', display: 'flex', alignItems: 'center', gap: '10px', background: '#0d0d15' }}>
        <div style={{ background: '#7c3aed22', borderRadius: '8px', padding: '6px', display: 'flex' }}>
          <Bot size={16} color="#7c3aed" />
        </div>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>Forge Chat</div>
          <div style={{ fontSize: '11px', color: '#64748b' }}>Model: {currentModel}</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', animation: 'pulse 2s infinite' }} />
          <span style={{ fontSize: '11px', color: '#10b981' }}>connected</span>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: m.role === 'user' ? 'row-reverse' : 'row', gap: '10px', alignItems: 'flex-start' }}>
            <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: m.role === 'user' ? '#3b82f622' : '#7c3aed22', border: `1px solid ${m.role === 'user' ? '#3b82f644' : '#7c3aed44'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {m.role === 'user' ? <User size={14} color="#3b82f6" /> : <Bot size={14} color="#7c3aed" />}
            </div>
            <div style={{ maxWidth: '70%', background: m.role === 'user' ? '#3b82f611' : '#111118', border: `1px solid ${m.role === 'user' ? '#3b82f633' : '#1e1e2e'}`, borderRadius: m.role === 'user' ? '12px 4px 12px 12px' : '4px 12px 12px 12px', padding: '12px 16px' }}>
              {m.model && m.role === 'assistant' && <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '6px' }}>{m.model}</div>}
              <div style={{ fontSize: '14px', color: '#e2e8f0', lineHeight: 1.6 }}>
                <MessageContent text={m.content} />
                {m.streaming && <span style={{ display: 'inline-block', width: '2px', height: '14px', background: '#7c3aed', animation: 'blink 1s infinite', marginLeft: '2px', verticalAlign: 'middle' }} />}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Quick actions */}
      <div style={{ padding: '8px 20px', display: 'flex', gap: '8px', borderTop: '1px solid #1e1e2e', overflowX: 'auto' }}>
        {QUICK_ACTIONS.map(({ label, icon: Icon, template }) => (
          <button key={label} onClick={() => { setInput(template); inputRef.current?.focus() }} style={{ background: '#1e1e2e', border: '1px solid #2d2d3e', borderRadius: '20px', padding: '4px 12px', color: '#94a3b8', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Icon size={11} /> {label}
          </button>
        ))}
      </div>

      {/* Input */}
      <div style={{ padding: '12px 20px', borderTop: '1px solid #1e1e2e', display: 'flex', gap: '10px', background: '#0d0d15' }}>
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
          placeholder="Ask The Forge anything..."
          disabled={streaming}
          style={{ flex: 1, background: '#111118', border: '1px solid #1e1e2e', borderRadius: '8px', padding: '10px 14px', color: '#e2e8f0', fontSize: '14px', outline: 'none' }}
        />
        <button onClick={() => send()} disabled={streaming || !input.trim()} style={{ background: streaming || !input.trim() ? '#1e1e2e' : 'linear-gradient(135deg, #7c3aed, #3b82f6)', border: 'none', borderRadius: '8px', padding: '10px 16px', color: streaming || !input.trim() ? '#64748b' : '#fff', cursor: streaming || !input.trim() ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '14px' }}>
          <Send size={16} />
        </button>
      </div>

      <style>{`
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
      `}</style>
    </div>
  )
}
