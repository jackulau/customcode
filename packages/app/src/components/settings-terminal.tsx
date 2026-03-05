import { type Component, type JSX } from "solid-js"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-shrink-0">{props.children}</div>
    </div>
  )
}

const fontSizeOptions = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24]
const cursorStyleOptions = ["bar", "block", "underline"] as const
const scrollbackOptions = [1000, 5000, 10000, 25000, 50000, 100000]

export const SettingsTerminal: Component = () => {
  const settings = useSettings()
  const language = useLanguage()

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">Terminal</h2>
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <div class="bg-surface-raised-base px-4 rounded-lg">
          <SettingsRow title="Font Size" description="The font size used in the terminal">
            <Select
              options={fontSizeOptions}
              current={fontSizeOptions.find((o) => o === settings.terminal.fontSize())}
              label={(o) => `${o}px`}
              onSelect={(option) => option && settings.terminal.setFontSize(option)}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>

          <SettingsRow title="Cursor Style" description="The style of the terminal cursor">
            <Select
              options={[...cursorStyleOptions]}
              current={cursorStyleOptions.find((o) => o === settings.terminal.cursorStyle()) as string}
              label={(o) => o.charAt(0).toUpperCase() + o.slice(1)}
              onSelect={(option) => option && settings.terminal.setCursorStyle(option as "bar" | "block" | "underline")}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>

          <SettingsRow title="Cursor Blink" description="Whether the terminal cursor blinks when focused">
            <Switch
              checked={settings.terminal.cursorBlink()}
              onChange={(checked) => settings.terminal.setCursorBlink(checked)}
            />
          </SettingsRow>

          <SettingsRow title="Scrollback" description="Maximum number of lines stored in the terminal buffer">
            <Select
              options={scrollbackOptions}
              current={scrollbackOptions.find((o) => o === settings.terminal.scrollback())}
              label={(o) => o.toLocaleString()}
              onSelect={(option) => option && settings.terminal.setScrollback(option)}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>

          <SettingsRow title="Startup Command" description="Command to run automatically when a new terminal is opened">
            <TextField
              value={settings.terminal.startupCommand()}
              onChange={(value) => settings.terminal.setStartupCommand(value)}
              placeholder="e.g. source .env && clear"
              class="w-64 font-mono"
              hideLabel
            />
          </SettingsRow>
        </div>
      </div>
    </div>
  )
}
