'use client';

import { useState, useCallback, useRef } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

// The five vehicle configurations the coach can resolve to.
export type ConfigId =
  | 'overland_trailblazer'
  | 'mobile_atelier'
  | 'field_workshop'
  | 'basecamp_explorer'
  | 'momentum_commuter';

export interface FutureSelf {
  headline: string;
  narrative: string;
  config_id: ConfigId;
  primaryColor: string;
  accentColor: string;
}

export interface GothamRevealPayload {
  type: 'gotham_reveal';
  future_self: FutureSelf;
  caption: string;
  closingMessage: string;
}

export type ChatState = 'idle' | 'loading' | 'revealed' | 'error';

// Neutral kickoff — the user has entered the experience, not a shopping funnel.
const KICKOFF = 'Hi, I want to discover my next self.';

// Miles' opening is fixed and spoken locally. There is no longer an intro
// screen to cover the round trip, so asking the model for this line would leave
// the user watching a silent orb for a second or two before anything happened.
// The chat system prompt knows this line was already said and never repeats it.
export const OPENING_LINE =
  "Hey there — I'm Miles, and I'm here to help you find your Fathom. Change starts with a name. What's yours?";

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<ChatState>('idle');
  const [reveal, setReveal] = useState<GothamRevealPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const questionCount = useRef(0);

  const addMessage = useCallback((role: 'user' | 'assistant', content: string): ChatMessage => {
    const msg: ChatMessage = {
      id: `${Date.now()}-${Math.random()}`,
      role,
      content,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, msg]);
    return msg;
  }, []);

  const sendMessage = useCallback(
    async (userInput: string) => {
      if (!userInput.trim() || state === 'loading' || state === 'revealed') return;

      setError(null);
      setState('loading');

      const userMsg = addMessage('user', userInput.trim());
      if (userMsg.role === 'user') questionCount.current += 1;

      const conversationHistory = [
        ...messages,
        { role: 'user' as const, content: userInput.trim() },
      ].map((m) => ({ role: m.role, content: m.content }));

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: conversationHistory }),
        });

        if (!res.ok) throw new Error('API error');

        const data = await res.json();

        if (data.type === 'gotham_reveal') {
          setReveal(data.data);
          setState('revealed');
        } else {
          addMessage('assistant', data.content);
          setState('idle');
        }
      } catch (err) {
        console.error(err);
        setError('Something went wrong. Please try again.');
        setState('error');
      }
    },
    [messages, state, addMessage]
  );

  // Seeds the transcript locally — no network. The kickoff stays in history so
  // the model still sees a user turn first, which startChat requires.
  const startConversation = useCallback(() => {
    if (messages.length > 0) return;
    addMessage('user', KICKOFF);
    addMessage('assistant', OPENING_LINE);
    setState('idle');
  }, [messages.length, addMessage]);

  const reset = useCallback(() => {
    setMessages([]);
    setState('idle');
    setReveal(null);
    setError(null);
    questionCount.current = 0;
  }, []);

  return {
    messages,
    state,
    reveal,
    error,
    questionCount: questionCount.current,
    sendMessage,
    startConversation,
    reset,
  };
}
