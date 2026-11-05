import { useApp, type Draft, type ReplayTab, type ReplayTarget } from '../state';
import { Icon } from './icons';

/** The one wording for opening something in Replay, so every screen says the same thing. */
export const REPLAY_LABEL = 'Send to Replay';
export const REPLAY_TITLE = 'Open in Replay to edit and send it again (Ctrl R)';
export const WS_REPLAY_TITLE = 'Open in Replay to edit the handshake and messages and run the connection again (Ctrl R)';
export const DRAFT_TITLE = 'Open in Replay as a new request to edit and send';

type Target =
  /** A recorded exchange, when its method and path are at hand (no lookup). */
  | { exchange: ReplayTarget; options?: ReplayTab['options'] }
  /** A recorded exchange known only by id. */
  | { id: string }
  /** A request that was never recorded, built here (or made when clicked). */
  | { draft: Draft | (() => Promise<Draft | null>); label?: string }
  /** A screen that builds the request itself (from an API file, a path...) and opens it. */
  | { build: () => unknown };

/**
 * Send something to Replay. Every screen uses this button, so it always has
 * the same icon, words and tooltip: "Send to Replay", or "Replay" where space
 * is short (`compact`), or just the icon in a dense row (`iconOnly`).
 */
export function ReplayButton(props: Target & { compact?: boolean; iconOnly?: boolean; primary?: boolean; title?: string; className?: string; disabled?: boolean; children?: React.ReactNode; ariaLabel?: string }) {
  const { openReplay, openReplayById, openDraft, notify } = useApp();
  const isDraft = 'draft' in props || 'build' in props;
  const go = async () => {
    try {
      if ('exchange' in props) openReplay(props.exchange, props.options);
      else if ('id' in props) await openReplayById(props.id);
      else if ('build' in props) await props.build();
      else {
        const d = typeof props.draft === 'function' ? await props.draft() : props.draft;
        if (d) openDraft(d, props.label);
      }
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const label = props.children ?? (props.compact ? 'Replay' : REPLAY_LABEL);
  return (
    <button
      className={props.className ?? `btn small${props.primary ? ' primary' : ''}`}
      title={props.title ?? (isDraft ? DRAFT_TITLE : 'exchange' in props && props.exchange.isWebSocket ? WS_REPLAY_TITLE : REPLAY_TITLE)}
      aria-label={props.ariaLabel ?? (props.iconOnly ? REPLAY_LABEL : undefined)}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        void go();
      }}
    >
      <Icon name="replay" size={props.iconOnly || props.compact ? 11 : 12} />
      {!props.iconOnly && <> {label}</>}
    </button>
  );
}
