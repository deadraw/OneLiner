import type { ClientModule } from 'claude-code'

/** A hover detail wider than the room it has: it rests, slides left until its end shows, rests, starts over. */
type Props = { text: string; color?: string; dim?: boolean }
// One object kept across calls: the clock reads the latest text from it, not the first call's props.
type Live = { text: string; offset: number; wait: number }
type State = { live: Live }

// Text moves a whole cell at a time, so smooth is short, even steps that ease in and out.
const TICK_MS = 40
const STEP_TICKS = 5 // one cell every 200 ms at full speed
const EASE_CELLS = 3 // the first and last cells of the slide take twice as long
const REST_TICKS = 50 // 2 s at each end

const Marquee: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    const live: Live = { text: props.text, offset: 0, wait: REST_TICKS }
    surface.setState({ live })
    surface.every(TICK_MS, () => {
      const end = Math.max(0, [...live.text].length - surface.columns)
      if (end === 0 && live.offset === 0) return // fits: nothing moves, nothing redraws
      if (live.wait > 0) { live.wait -= 1; return } // waiting draws nothing new
      if (live.offset >= end) { live.offset = 0; live.wait = REST_TICKS }
      else {
        live.offset += 1
        const isEasing = live.offset < EASE_CELLS || end - live.offset < EASE_CELLS
        live.wait = live.offset >= end ? REST_TICKS : (isEasing ? STEP_TICKS * 2 : STEP_TICKS) - 1
      }
      surface.setState({ live })
    })
  }
  const live = surface.state?.live
  if (live && live.text !== props.text) { live.text = props.text; live.offset = 0; live.wait = REST_TICKS }
  const chars = [...props.text]
  const offset = Math.min(live?.offset ?? 0, Math.max(0, chars.length - surface.columns))
  return <Text color={props.color} dimColor={props.dim} wrap="truncate">{chars.slice(offset).join('')}</Text>
}

export default Marquee
