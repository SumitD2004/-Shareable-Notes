import { useEffect, useMemo, useRef, useState } from 'react'
import { FaRegStickyNote, FaSun, FaMoon, FaSearch, FaPlus, FaTrash, FaThumbtack } from 'react-icons/fa'
import './App.css'

// Storage helpers - using localStorage for persistent storage
function saveToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn('Failed to save to localStorage:', error)
  }
}

function loadFromStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch (error) {
    console.warn('Failed to load from localStorage:', error)
    return fallback
  }
}

// Crypto helpers (AES-GCM with PBKDF2)
async function deriveKey(password, salt) {
  const enc = new TextEncoder()
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}
async function encryptString(content, password) {
  const enc = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(content))
  return {
    salt: btoa(String.fromCharCode(...salt)),
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(cipherBuf)))
  }
}
async function decryptString(encrypted, password) {
  const dec = new TextDecoder()
  const salt = Uint8Array.from(atob(encrypted.salt), c => c.charCodeAt(0))
  const iv = Uint8Array.from(atob(encrypted.iv), c => c.charCodeAt(0))
  const data = Uint8Array.from(atob(encrypted.ciphertext), c => c.charCodeAt(0))
  const key = await deriveKey(password, salt)
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
  return dec.decode(plainBuf)
}

// Env-configurable endpoints and models
const OPENAI_API_BASE = import.meta?.env?.VITE_OPENAI_API_BASE || 'https://api.openai.com/v1'
const OPENAI_MODEL = import.meta?.env?.VITE_OPENAI_MODEL || 'gpt-4o-mini'
const LT_API_URL = import.meta?.env?.VITE_LT_API_URL || 'https://api.languagetool.org/v2'

// AI helpers (OpenAI optional; fallback heuristics)
async function callOpenAI(prompt, apiKey) {
  if(!apiKey) return null
  try{
    const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: 'You are a helpful assistant for a notes app.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 120
      })
    })
    const data = await res.json()
    return data?.choices?.[0]?.message?.content?.trim() ?? null
  } catch {
    return null
  }
}
function heuristicSummary(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > 160 ? cleaned.slice(0, 157) + '…' : cleaned
}
function heuristicTags(text) {
  const words = Array.from(new Set((text.toLowerCase().match(/[a-z]{4,}/g) || [])))
    .filter(w => !['this','that','with','from','your','have','about','there','their','which','will','into','only','also','been','were','when','what','where','then','than','because','while','these','those','such','some','more','most'].includes(w))
  return words.slice(0, 5)
}

// Grammar check via LanguageTool (env-configurable)
async function languageToolCheck(text) {
  try {
    const res = await fetch(`${LT_API_URL}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text, language: 'en-US' })
    })
    const data = await res.json()
    return data?.matches || []
  } catch {
    return []
  }
}

// Glossary extraction
async function extractGlossary(text, apiKey){
  const heuristic = () => {
    const terms = Array.from(new Set((text.match(/\b([A-Z][a-zA-Z]{2,})\b/g) || [])))
    return terms.slice(0, 10).map(t => ({ term: t, definition: 'Important term detected from context.' }))
  }
  const ai = await callOpenAI(`Extract up to 10 key terms with brief definitions as JSON array of {term, definition} from this note:\n\n${text}`, apiKey)
  try {
    if (ai) {
      const jsonStart = ai.indexOf('[')
      const jsonStr = jsonStart >= 0 ? ai.slice(jsonStart) : ai
      const parsed = JSON.parse(jsonStr)
      if (Array.isArray(parsed)) return parsed
    }
  } catch {}
  return heuristic()
}

function Toolbar({ onCommand, onFontSize, onAlign, onGlossary, onSummarize, onTags, onGrammar, isEncrypted, onEncryptToggle }) {
  const [isProcessing, setIsProcessing] = useState(false)

  const handleAIAction = async (action) => {
    setIsProcessing(true)
    await action()
    setIsProcessing(false)
  }

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button className="toolbar-btn" onClick={() => onCommand('bold')} title="Bold">
          <b>B</b>
        </button>
        <button className="toolbar-btn" onClick={() => onCommand('italic')} title="Italic">
          <i>I</i>
        </button>
        <button className="toolbar-btn" onClick={() => onCommand('underline')} title="Underline">
          <u>U</u>
        </button>
      </div>
      
      <div className="toolbar-group">
        <select className="toolbar-select" onChange={e => onFontSize(e.target.value)} defaultValue="16" title="Font Size">
          <option value="12">12px</option>
          <option value="14">14px</option>
          <option value="16">16px</option>
          <option value="20">20px</option>
          <option value="24">24px</option>
        </select>
      </div>

      <div className="toolbar-group">
        <button className="toolbar-btn" onClick={() => onAlign('left')} title="Align Left">⟸</button>
        <button className="toolbar-btn" onClick={() => onAlign('center')} title="Align Center">≡</button>
        <button className="toolbar-btn" onClick={() => onAlign('right')} title="Align Right">⟹</button>
      </div>
      
      <div className="toolbar-spacer" />
      
      <div className="toolbar-group ai-tools">
        <button className="toolbar-btn ai-btn" onClick={() => handleAIAction(onGlossary)} disabled={isProcessing}>
          {isProcessing ? '...' : 'Glossary'}
        </button>
        <button className="toolbar-btn ai-btn" onClick={() => handleAIAction(onSummarize)} disabled={isProcessing}>
          {isProcessing ? '...' : 'Summarize'}
        </button>
        <button className="toolbar-btn ai-btn" onClick={() => handleAIAction(onTags)} disabled={isProcessing}>
          {isProcessing ? '...' : 'Tags'}
        </button>
        <button className="toolbar-btn ai-btn" onClick={() => handleAIAction(onGrammar)} disabled={isProcessing}>
          {isProcessing ? '...' : 'Grammar'}
        </button>
      </div>

      <div className="encrypt-toggle">
        <label>
          <input type="checkbox" checked={isEncrypted} onChange={onEncryptToggle} />
          <span className="toggle-slider"></span>
          <span className="toggle-label">Encrypt</span>
        </label>
      </div>
    </div>
  )
}

function NotesList({ notes, onSelect, onCreate, onDelete, onPin, activeId, onSearch, search }) {
  return (
    <div className="notes-list">
      <div className="notes-list-header">
        <div className="search-container">
          <FaSearch className="search-icon" />
          <input 
            className="search-input" 
            placeholder="Search notes…" 
            value={search} 
            onChange={e => onSearch(e.target.value)} 
          />
        </div>
        <button className="create-btn" onClick={onCreate}>
          <FaPlus />
          <span>New</span>
        </button>
      </div>
      <div className="notes-items">
        {notes.map((n, index) => (
          <div 
            key={n.id} 
            className={`note-item ${activeId===n.id?'active':''}`} 
            onClick={() => onSelect(n.id)}
            style={{ '--delay': `${index * 0.05}s` }}
          >
            <div className="note-content">
              <div className="note-title">
                {n.pinned && <FaThumbtack className="pin-icon" />}
                <span>{n.title || 'Untitled'}</span>
                {n.encrypted && <div className="encryption-badge">🔒</div>}
              </div>
              <div className="note-meta">
                {n.summary ? n.summary : (n.text || '').slice(0, 80)}
              </div>
              {n.tags && n.tags.length > 0 && (
                <div className="note-tags">
                  {n.tags.slice(0, 3).map((tag, i) => (
                    <span key={i} className="tag">{tag}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="note-actions" onClick={e=>e.stopPropagation()}>
              <button 
                className="action-btn pin-btn" 
                title={n.pinned ? "Unpin" : "Pin"} 
                onClick={() => onPin(n.id)}
              >
                <FaThumbtack className={n.pinned ? 'pinned' : ''} />
              </button>
              <button 
                className="action-btn delete-btn" 
                title="Delete" 
                onClick={() => onDelete(n.id)}
              >
                <FaTrash />
              </button>
            </div>
          </div>
        ))}
        {notes.length === 0 && (
          <div className="empty-notes">
            <FaRegStickyNote size={32} />
            <p>No notes yet. Create your first note!</p>
          </div>
        )}
      </div>
    </div>
  )
}

function Editor({ html, setHtml, onTitleChange, title, glossary, grammarMatches }) {
  const ref = useRef(null)
  const [isFocused, setIsFocused] = useState(false)
  
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== html) {
      ref.current.innerHTML = html
    }
  }, [html])
  
  const onInput = () => {
    setHtml(ref.current.innerHTML)
  }
  
  return (
    <div className="editor">
      <input 
        className="title-input" 
        placeholder="Enter note title..." 
        value={title} 
        onChange={e=>onTitleChange(e.target.value)} 
      />
      <div 
        className={`editor-area ${isFocused ? 'focused' : ''}`}
        ref={ref} 
        contentEditable 
        onInput={onInput} 
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        suppressContentEditableWarning={true}
        data-placeholder="Start writing your note..."
      />
      
      {glossary?.length > 0 && (
        <div className="glossary slide-in">
          <h3>📚 Glossary</h3>
          <div className="glossary-grid">
            {glossary.map((g, i) => (
              <div key={i} className="glossary-item">
                <strong>{g.term}</strong>
                <span>{g.definition}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {grammarMatches?.length > 0 && (
        <div className="grammar slide-in">
          <h3>✏️ Grammar Suggestions</h3>
          <div className="grammar-list">
            {grammarMatches.map((m, i) => (
              <div key={i} className="grammar-item">
                <div className="grammar-message">{m.message}</div>
                {m.shortMessage && (
                  <div className="grammar-hint">{m.shortMessage}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function App() {
  const [theme, setTheme] = useState(() => loadFromStorage('pp_theme', 'dark'))
  const [notes, setNotes] = useState(() => loadFromStorage('pp_notes', []))
  const [activeId, setActiveId] = useState(() => loadFromStorage('pp_active', null))
  const ENV_OPENAI = import.meta?.env?.VITE_OPENAI_API_KEY || ''
  const [apiKey, setApiKey] = useState(() => loadFromStorage('pp_openai', ENV_OPENAI))
  const hasStoredApiKey = useMemo(() => !!loadFromStorage('pp_openai', ''), [])
  const usingEnvApiKey = !hasStoredApiKey && !!ENV_OPENAI
  const [search, setSearch] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [saveStatus, setSaveStatus] = useState('saved') // 'saving', 'saved', 'error'
  const fileInputRef = useRef(null)
  
  const activeNote = useMemo(() => notes.find(n => n.id===activeId) || null, [notes, activeId])
  const [editorHtml, setEditorHtml] = useState(activeNote?.html || '')
  const [glossary, setGlossary] = useState([])
  const [grammarMatches, setGrammarMatches] = useState([])
  
  function clearStoredApiKey() {
    try {
      localStorage.removeItem('pp_openai')
    } catch {}
    setApiKey(ENV_OPENAI)
  }

  // Auto-save with status indication
  useEffect(() => { 
    setSaveStatus('saving')
    const timeoutId = setTimeout(() => {
      try {
        saveToStorage('pp_notes', notes)
        setSaveStatus('saved')
      } catch (error) {
        setSaveStatus('error')
        console.error('Failed to save notes:', error)
      }
    }, 500) // Debounce saves
    return () => clearTimeout(timeoutId)
  }, [notes])
  
  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ctrl/Cmd + S to manually trigger save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        setSaveStatus('saving')
        try {
          saveToStorage('pp_notes', notes)
          saveToStorage('pp_active', activeId)
          saveToStorage('pp_openai', apiKey)
          saveToStorage('pp_theme', theme)
          setSaveStatus('saved')
        } catch (error) {
          setSaveStatus('error')
          console.error('Manual save failed:', error)
        }
      }
      // Ctrl/Cmd + N for new note
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault()
        createNote()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [notes, activeId, apiKey, theme])
  
  useEffect(() => { 
    saveToStorage('pp_active', activeId) 
  }, [activeId])
  
  useEffect(() => { 
    // Persist only user-provided keys; do not save the .env key value
    if (apiKey && apiKey !== ENV_OPENAI) {
      saveToStorage('pp_openai', apiKey)
    }
  }, [apiKey])
  
  useEffect(() => { 
    saveToStorage('pp_theme', theme)
    document.body.setAttribute('data-theme', theme)
  }, [theme])
  
  useEffect(() => { 
    if (activeNote) setEditorHtml(activeNote.html || '') 
  }, [activeId])

  function upsertNote(partial) {
    setNotes(prev => prev.map(n => n.id===activeId ? { ...n, ...partial, updatedAt: Date.now() } : n))
  }

  function exec(cmd, val=null){
    document.execCommand(cmd, false, val)   
    setTimeout(()=> setEditorHtml(document.querySelector('.editor-area')?.innerHTML || ''), 0)
  }
  
  function setFontSize(size) {
    exec('fontSize', 7)
    const area = document.querySelector('.editor-area')
    if (!area) return
    area.querySelectorAll('font[size="7"]').forEach(el => {
      el.removeAttribute('size'); el.style.fontSize = size+'px'
    })
    setEditorHtml(area.innerHTML)
  }
  
  function setAlign(al) { exec(`justify${al}`) }

  function createNote() {
    const id = crypto.randomUUID()
    const newNote = { 
      id, 
      title: '', 
      html: '', 
      text: '', 
      pinned: false, 
      encrypted: false, 
      summary: '', 
      tags: [], 
      createdAt: Date.now(), 
      updatedAt: Date.now(), 
      encryptedPayload: null 
    }
    setNotes(prev => [newNote, ...prev])
    setActiveId(id)
    setGlossary([])
    setGrammarMatches([])
  }
  
  function deleteNote(id) {
    setNotes(prev => prev.filter(n => n.id!==id))
    if (activeId===id) setActiveId(null)
  }
  
  function pinNote(id) {
    setNotes(prev => prev.map(n => n.id===id ? { ...n, pinned: !n.pinned } : n))
  }
  
  function onSearch(q) {
    setSearch(q)
  }

  useEffect(() => {
    if (!activeNote) return
    const tmp = document.createElement('div')
    tmp.innerHTML = editorHtml
    const text = tmp.textContent || ''
    upsertNote({ html: editorHtml, text })
  }, [editorHtml])

  function wrapGlossary(html, terms) {
    if (!terms?.length) return html
    let out = html
    for (const g of terms) {
      const pattern = new RegExp(`(>[^<]*)\\b(${g.term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')})\\b`, 'gi')
      out = out.replace(pattern, (m, a, b) => `${a.replace(/&/g,'&amp;').replace(/</g,'&lt;')}<span class=\"glossary-term\" title=\"${g.definition.replace(/\"/g,'\\\"')}\">${b}</span>`)
    }
    return out
  }

  async function doGlossary() {
    const tmp = document.createElement('div'); tmp.innerHTML = editorHtml; const text = tmp.textContent || ''
    const terms = await extractGlossary(text, apiKey)
    setGlossary(terms)
    const wrapped = wrapGlossary(editorHtml, terms)
    setEditorHtml(wrapped)
  }

  async function doSummarize() {
    const tmp = document.createElement('div'); tmp.innerHTML = editorHtml; const text = tmp.textContent || ''
    const ai = await callOpenAI(`Summarize this note in 1-2 lines:\n\n${text}`, apiKey)
    const summary = ai || heuristicSummary(text)
    upsertNote({ summary })
    alert('Summary saved to note meta:\n\n' + summary)
  }

  async function doTags() {
    const tmp = document.createElement('div'); tmp.innerHTML = editorHtml; const text = tmp.textContent || ''
    const ai = await callOpenAI(`Suggest 3-5 short tags for this note as a comma-separated list:\n\n${text}`, apiKey)
    const tags = ai ? ai.split(/[\,\n]/).map(s=>s.trim()).filter(Boolean).slice(0,5) : heuristicTags(text)
    upsertNote({ tags })
    alert('Tags suggested: ' + tags.join(', '))
  }

  function clearGrammarSpans(root) {
    root.querySelectorAll('span.grammar-error').forEach(s => {
      const parent = s.parentNode
      while (s.firstChild) parent.insertBefore(s.firstChild, s)
      parent.removeChild(s)
    })
  }

  async function doGrammar() {
    const container = document.createElement('div'); container.innerHTML = editorHtml
    clearGrammarSpans(container)
    const text = container.textContent || ''
    const matches = await languageToolCheck(text)
    setGrammarMatches(matches)
    let offset = 0
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        let nodeStart = offset
        let nodeEnd = offset + node.nodeValue.length
        const applicable = matches.filter(m => !(m.offset + m.length <= nodeStart || m.offset >= nodeEnd))
        if (applicable.length) {
          const frag = document.createDocumentFragment()
          let cursor = 0
          for (const m of applicable.sort((a,b)=>a.offset-b.offset)) {
            const start = Math.max(0, m.offset - nodeStart)
            const end = Math.min(node.nodeValue.length, m.offset + m.length - nodeStart)
            if (start > cursor) frag.appendChild(document.createTextNode(node.nodeValue.slice(cursor, start)))
            const span = document.createElement('span')
            span.className = 'grammar-error'
            span.title = m.message
            span.textContent = node.nodeValue.slice(start, end)
            frag.appendChild(span)
            cursor = end
          }
          if (cursor < node.nodeValue.length) frag.appendChild(document.createTextNode(node.nodeValue.slice(cursor)))
          node.parentNode.replaceChild(frag, node)
        }
        offset = nodeEnd
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of Array.from(node.childNodes)) walk(child)
      }
    }
    walk(container)
    setEditorHtml(container.innerHTML)
  }

  async function toggleEncryption() {
    if (!activeNote) return
    if (!activeNote.encrypted) {
      const password = prompt('Set a password for this note:')
      if (!password) return
      const encrypted = await encryptString(editorHtml, password)
      upsertNote({ encrypted: true, html: '', encryptedPayload: encrypted })
      setEditorHtml('')
    } else {
      const password = prompt('Enter password to decrypt:')
      if (!password) return
      try {
        const plain = await decryptString(activeNote.encryptedPayload, password)
        upsertNote({ encrypted: false, html: plain, encryptedPayload: null })
        setEditorHtml(plain)
      } catch (e) {
        alert('Incorrect password or corrupted data.')
      }
    }
  }

  const sortedFilteredNotes = useMemo(() => {
    const sorted = [...notes].sort((a,b)=> (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt))
    const q = search.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter(n => (n.title||'').toLowerCase().includes(q) || (n.text||'').toLowerCase().includes(q))
  }, [notes, search])

  // Export/Import functions
  const exportData = () => {
    const dataToExport = {
      notes,
      exportDate: new Date().toISOString(),
      version: '1.0'
    }
    const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `playpower-notes-${new Date().toISOString().split('T')[0]}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const importData = (event) => {
    const file = event.target.files[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const importedData = JSON.parse(e.target.result)
        if (importedData.notes && Array.isArray(importedData.notes)) {
          const confirmImport = window.confirm(
            `Import ${importedData.notes.length} notes? This will merge with your existing notes.`
          )
          if (confirmImport) {
            setNotes(prev => {
              const existingIds = new Set(prev.map(n => n.id))
              const newNotes = importedData.notes.filter(n => !existingIds.has(n.id))
              return [...prev, ...newNotes].sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            })
            setSaveStatus('saved')
            alert(`Successfully imported ${importedData.notes.length} notes!`)
          }
        } else {
          alert('Invalid file format. Please select a valid notes export file.')
        }
      } catch (error) {
        console.error('Import error:', error)
        alert('Failed to import notes. Please check the file format.')
      }
    }
    reader.readAsText(file)
    event.target.value = '' // Reset file input
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <FaRegStickyNote className="brand-icon" />
          <span className="brand-text">PlayPower Notes</span>
          <div className="brand-glow"></div>
        </div>
        
        <div className="header-center">
          <div className={`save-status ${saveStatus}`}>
            {saveStatus === 'saving' && <span>💾 Saving...</span>}
            {saveStatus === 'saved' && <span>✅ Saved</span>}
            {saveStatus === 'error' && <span>⚠️ Save Error</span>}
          </div>
        </div>
        
        <button 
          className="theme-toggle" 
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} 
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <FaSun /> : <FaMoon />}
        </button>
      </header>
      
      <div className="content">
        <div className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <NotesList
            notes={sortedFilteredNotes}
            onSelect={setActiveId}
            onCreate={createNote}
            onDelete={deleteNote}
            onPin={pinNote}
            activeId={activeId}
            onSearch={onSearch}
            search={search}
          />
          <div className="settings">
            <div className="settings-group">
              <label>OpenAI API Key (optional)</label>
              {usingEnvApiKey ? (
                <input
                  type="password"
                  placeholder="Using .env VITE_OPENAI_API_KEY"
                  value={''}
                  readOnly
                  disabled
                />
              ) : (
                <input 
                  type="password"
                  placeholder="sk-..." 
                  value={apiKey} 
                  onChange={e=>setApiKey(e.target.value)} 
                />
              )}
              {!usingEnvApiKey && hasStoredApiKey && (
                <div className="data-controls" style={{ marginTop: '0.5rem' }}>
                  <button className="import-btn" onClick={clearStoredApiKey}>Clear saved key (use .env)</button>
                </div>
              )}
            </div>
            <div className="settings-group">
              <label>Data Management</label>
              <div className="data-controls">
                <button className="export-btn" onClick={exportData}>
                  Export Notes
                </button>
                <input 
                  type="file" 
                  accept=".json"
                  onChange={importData}
                  style={{ display: 'none' }}
                  ref={fileInputRef}
                />
                <button className="import-btn" onClick={() => fileInputRef.current?.click()}>
                  Import Notes
                </button>
              </div>
              <div className="storage-info">
                {notes.length} notes • {Math.round(JSON.stringify(notes).length / 1024)}KB used
              </div>
            </div>
          </div>
        </div>
        
        <div className="main">
          {activeNote && (
            <Toolbar
              onCommand={exec}
              onFontSize={setFontSize}
              onAlign={setAlign}
              onGlossary={doGlossary}
              onSummarize={doSummarize}
              onTags={doTags}
              onGrammar={doGrammar}
              isEncrypted={!!activeNote?.encrypted}
              onEncryptToggle={toggleEncryption}
            />
          )}
          
          {activeNote ? (
            <Editor
              html={editorHtml}
              setHtml={setEditorHtml}
              title={activeNote.title}
              onTitleChange={t=>upsertNote({ title: t })}
              glossary={glossary}
              grammarMatches={grammarMatches}
            />
          ) : (
            <div className="empty">
              <div className="empty-icon">
                <FaRegStickyNote />
              </div>
              <div className="empty-content">
                <h2>Welcome to PlayPower Notes</h2>
                <p>Select a note from the sidebar or create a new one to get started</p>
                <button className="cta-button" onClick={createNote}>
                  <FaPlus />
                  Create Your First Note
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default App;