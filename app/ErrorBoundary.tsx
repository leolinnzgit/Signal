"use client";

import React, { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  name?: string;
  onReset?: () => void;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`ErrorBoundary caught error in ${this.props.name || "component"}:`, error, errorInfo);
  }

  public reset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="error-boundary-card" role="alert">
          <div className="error-boundary-content">
            <span className="error-boundary-icon" aria-hidden="true">⚠️</span>
            <h3>{this.props.name || "Component"} Encountered an Issue</h3>
            <p className="error-boundary-msg">
              {this.state.error?.message || "An unexpected error occurred while rendering."}
            </p>
            <div className="error-boundary-actions">
              <button type="button" className="error-boundary-btn retry" onClick={this.reset}>
                🔄 Retry
              </button>
              {this.props.onReset && (
                <button type="button" className="error-boundary-btn dismiss" onClick={this.props.onReset}>
                  ✕ Close
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
