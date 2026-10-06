/*
 * Custom UI controls (design "공통 스타일", Req 31.2; task 14.1). None of them uses a browser form look: buttons have
 * their default look removed, sliders and switches are drawn elements with `role="slider"` / `role="switch"`, tabs
 * and segmented choices are ARIA tab / radio groups. All are focusable, follow mouse hover into the focus, and work
 * with the ScreenManager's FocusNav (a focused slider consumes left / right).
 */
export { button, setButtonLabel, setDisabledReason, type ButtonOptions } from './button';
export { segmented, type SegmentedControl, type SegmentedOptions, type SegmentOption } from './segmented';
export { slider, type SliderControl, type SliderOptions } from './slider';
export { tabs, type TabDef, type TabsControl, type TabsOptions } from './tabs';
export { toggleSwitch, type SwitchControl, type SwitchOptions } from './toggle';
export { formatPercent, snapValue, stepValue, valueAtRatio, valueRatio, type SliderRange } from './values';
