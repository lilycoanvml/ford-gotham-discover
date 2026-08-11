'use client';

import { useState, useCallback, useRef } from 'react';
import { OPENING_LINE, QUESTIONS, ANSWERS_BEFORE_REVEAL } from '@/app/lib/script';

export { OPENING_LINE } from '@/app/lib/script';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  /* Miles' turn split for speech: [reaction, question]. The reaction is
     synthesised live; the question's audio is already cached, so it follows
     with no gap. `content` is the two joined, which is what history and
     assistive tech see. */
  parts?: string[];
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


export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<ChatState>('idle');
  const [reveal, setReveal] = useState<GothamRevealPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True while the final-turn reaction is in flight, so the reveal hand-off
  // knows to wait for a line that has not arrived yet.
  const [bridging, setBridging] = useState(false);
  const questionCount = useRef(0);

  const addMessage = useCallback((role: 'user' | 'assistant', content: string, parts?: string[]): ChatMessage => {
    const msg: ChatMessage = {
      id: `${Date.now()}-${Math.random()}`,
      role,
      content,
      timestamp: new Date(),
      ...(parts ? { parts } : {}),
    };
    setMessages((prev) => [...prev, msg]);
    return msg;
  }, []);

  const sendMessage = useCallback(
    async (userInput: string) => {
      if (!userInput.trim() || state === 'loading' || state === 'revealed') return;

      setError(null);
      setState('loading');

      addMessage('user', userInput.trim());
      questionCount.current += 1;

      const conversationHistory = [
        ...messages,
        { role: 'user' as const, content: userInput.trim() },
      ].map((m) => ({ role: m.role, content: m.content }));

      // How many real answers we now hold — the seeded kickoff isn't one. The
      // first answer is their name, so answer N is followed by QUESTIONS[N-1].
      const answered = conversationHistory.filter(m => m.role === 'user').length - 1;
      const question: string | undefined = QUESTIONS[answered - 1];
      const isFinal = answered >= ANSWERS_BEFORE_REVEAL;
      const stage = isFinal ? 'reveal' : 'reaction';

      /*
       * The reveal takes ~6.5s to generate, and the user spent all of it in
       * silence after answering. A reaction takes ~1.2s to reach audio, so the
       * final turn fires both at once: Miles answers them while the reveal is
       * still being written, and the screen only moves on once he's finished
       * the sentence (see the hand-off in ChatScreen).
       */
      if (isFinal) {
        setBridging(true);
        fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: conversationHistory, stage: 'reaction' }),
        })
          .then(r => (r.ok ? r.json() : null))
          .then(d => {
            const line = String(d?.content ?? '')
              .replace(/\s+/g, ' ')
              .replace(/[^.!?]*\?/g, '')   // never leave a dangling question here
              .replace(/\s+/g, ' ')
              .trim();
            if (line) addMessage('assistant', line);
          })
          .catch(() => { /* the reveal still lands; we just lose the bridge */ })
          .finally(() => setBridging(false));
      }

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: conversationHistory, stage }),
        });

        if (!res.ok) throw new Error('API error');

        const data = await res.json();

        if (data.type === 'gotham_reveal') {
          setReveal(data.data);
          setState('revealed');
        } else {
          // The model wrote the reaction; the question is ours. If it slipped a
          // question in anyway, drop it — otherwise the turn asks two things.
          const reaction = String(data.content ?? '').replace(/\s+/g, ' ').trim();
          if (question) {
            const clean = reaction.replace(/[^.!?]*\?/g, '').replace(/\s+/g, ' ').trim();
            addMessage('assistant', `${clean} ${question}`.trim(), clean ? [clean, question] : [question]);
          } else {
            addMessage('assistant', reaction);
          }
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
    setBridging(false);
    questionCount.current = 0;
  }, []);

  return {
    messages,
    state,
    reveal,
    error,
    bridging,
    questionCount: questionCount.current,
    sendMessage,
    startConversation,
    reset,
  };
}
