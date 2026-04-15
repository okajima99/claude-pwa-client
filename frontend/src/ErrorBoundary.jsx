import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100dvh',
          gap: '16px',
          fontFamily: 'sans-serif',
          color: '#ccc',
          background: '#1a1a1a',
        }}>
          <p style={{ margin: 0, fontSize: '14px' }}>エラーが発生しました</p>
          <pre style={{
            fontSize: '11px',
            color: '#888',
            maxWidth: '80vw',
            overflow: 'auto',
            margin: 0,
          }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 20px',
              background: '#333',
              color: '#ccc',
              border: '1px solid #555',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            リロード
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
