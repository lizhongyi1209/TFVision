"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CompositionEvent,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";

type ImeSafeTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "defaultValue" | "onChange" | "onCompositionStart" | "onCompositionEnd"
> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Mirrors the local IME draft for visual overlays without committing it to the store. */
  onDraftValueChange?: (value: string) => void;
};

/**
 * Keeps an IME composition local to the textarea. Updating the canvas store in
 * the middle of a composition can make React Flow rerender the node and cause
 * committed punctuation to be inserted twice or the composition to be reset.
 */
export const ImeSafeTextarea = forwardRef<HTMLTextAreaElement, ImeSafeTextareaProps>(
  function ImeSafeTextarea({ value, onValueChange, onDraftValueChange, onFocus, onBlur, onKeyDown, ...props }, forwardedRef) {
    const [draft, setDraft] = useState(value);
    const composingRef = useRef(false);
    const focusedRef = useRef(false);
    const lastCommittedRef = useRef(value);
    const onValueChangeRef = useRef(onValueChange);

    onValueChangeRef.current = onValueChange;

    useEffect(() => {
      if (focusedRef.current || composingRef.current) return;
      setDraft(value);
      lastCommittedRef.current = value;
    }, [value]);

    const commit = useCallback((next: string) => {
      if (lastCommittedRef.current === next) return;
      lastCommittedRef.current = next;
      onValueChangeRef.current(next);
    }, []);

    const finishComposition = useCallback((event: CompositionEvent<HTMLTextAreaElement>) => {
      composingRef.current = false;
      const next = event.currentTarget.value;
      setDraft(next);
      onDraftValueChange?.(next);
      commit(next);
    }, [commit, onDraftValueChange]);

    return (
      <textarea
        {...props}
        ref={forwardedRef}
        value={draft}
        onChange={(event) => {
          const next = event.currentTarget.value;
          const nativeEvent = event.nativeEvent as InputEvent;
          setDraft(next);
          onDraftValueChange?.(next);
          if (!composingRef.current && !nativeEvent.isComposing) commit(next);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={finishComposition}
        onFocus={(event) => {
          focusedRef.current = true;
          onFocus?.(event);
        }}
        onBlur={(event) => {
          composingRef.current = false;
          const next = event.currentTarget.value;
          setDraft(next);
          onDraftValueChange?.(next);
          commit(next);
          focusedRef.current = false;
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          if (isImeKeyEvent(event)) return;
          onKeyDown?.(event);
        }}
      />
    );
  },
);

export function isImeKeyEvent(event: Pick<KeyboardEvent<HTMLElement>, "nativeEvent" | "keyCode">) {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}
