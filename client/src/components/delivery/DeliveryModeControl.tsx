import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectModeSwitch } from "@roubo/shared/delivery-selectors";
import Callout from "../ui/Callout";
import { useModeSwitch } from "../../hooks/useDelivery";
import ModeSwitch from "./ModeSwitch";

// The Mode switch of the delivery's controls (SB-FR-032, SB-US-013), in the
// cost view's Decision mode panel, under the role matrix (#1623). Selecting a segment writes a mode_switch control (PUT
// .../delivery/mode). As a role change does, the switch shows pending from the
// outbox the snapshot carries: the old segment stays selected beside the
// pending badge until the session's `mode.changed` names the control's
// control_seq, which makes the new mode the one in effect and clears the badge.
export default function DeliveryModeControl({
  projectId,
  benchId,
  snapshot,
  disabled = false,
}: {
  projectId: string;
  benchId: number;
  snapshot: DeliverySnapshot;
  // True while the delivery is ended: no mode switch then.
  disabled?: boolean;
}) {
  const view = selectModeSwitch(snapshot);
  const change = useModeSwitch(projectId, benchId);
  return (
    <div data-testid="delivery-mode-control" data-mode={view.value} className="space-y-2">
      <ModeSwitch
        value={view.value}
        pending={view.pending}
        isDisabled={disabled || change.isPending}
        onChange={(mode) => change.mutate(mode)}
      />
      {change.isError && (
        <Callout role="alert" title="The mode switch was not sent">
          {change.error.message}
        </Callout>
      )}
    </div>
  );
}
