import React from 'react';

export class FeatureBoundary extends React.Component<{
  children: React.ReactNode; fallback?: React.ReactNode;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div>
      <p role="alert">This feature could not load. Save any drafts, reconnect, then reload to retry.</p>
      {this.props.fallback}
    </div>;
  }
}
