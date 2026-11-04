import { Component, type ReactNode } from 'react'

/** Keeps a rendering bug from blanking the whole app; saved models and results are unaffected. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="page narrow crash">
        <h1>Something went wrong</h1>
        <p className="muted">{this.state.error.message}</p>
        <button className="btn" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
