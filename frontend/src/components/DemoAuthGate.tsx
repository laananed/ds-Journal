import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { demoAuthenticationEnabled, setDemoCredentials } from '../api/demoAuth'

export default function DemoAuthGate({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState(!demoAuthenticationEnabled)
  const [login, setLogin] = useState(demoAuthenticationEnabled)
  const [username, setUsername] = useState('demo')
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    function onNotice(event: Event) {
      const detail = (event as CustomEvent<string>).detail
      if (detail === 'auth') { setPassword(''); setLogin(true); setNotice('认证已失效或需要登录。未保存内容保留在当前页面，请重新输入凭据。') }
      else if (detail === 'forbidden') setNotice('没有访问权限，未保存内容请保留在当前页面。')
      else if (detail === 'rate') setNotice('请求过于频繁，请稍后手动重试；未保存内容请保留在当前页面。')
      else if (detail === 'server') setNotice('服务暂时不可用，请稍后手动重试；未保存内容请保留在当前页面。')
      else if (detail === 'network') setNotice('无法连接服务：请检查网络或证书，未保存内容请保留在当前页面。')
    }
    window.addEventListener('seekjournal-demo-auth', onNotice)
    return () => window.removeEventListener('seekjournal-demo-auth', onNotice)
  }, [])
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!username || !password || username.includes(':')) return
    setDemoCredentials(username, password)
    setPassword('')
    setLogin(false)
    setNotice('认证信息已输入；如有失败操作，请确认状态后手动重试。')
    setOpened(true)
  }
  return <>
    {opened && children}
    {notice && !login && <div role="alert" style={{ position: 'fixed', zIndex: 10000, top: 8, left: 8, right: 8, padding: 12, background: '#fff1cf', color: '#322200' }}>{notice} <button onClick={() => setNotice('')}>关闭</button></div>}
    {login && <div role="dialog" aria-modal="true" aria-label="演示服务认证" style={{ position: 'fixed', zIndex: 10001, inset: 0, background: 'rgba(0,0,0,.65)', display: 'grid', placeItems: 'center', padding: 20 }}>
      <form onSubmit={submit} style={{ background: 'white', color: '#222', padding: 24, borderRadius: 12, width: 'min(100%, 380px)', display: 'grid', gap: 12 }}>
        <h1>连接演示服务</h1><p>{notice || '请输入演示账号和密码。凭据仅保留在本次页面会话中。'}</p>
        <label>账号<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required /></label>
        <label>密码<input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} required /></label>
        <button type="submit">继续</button>
      </form>
    </div>}
  </>
}
