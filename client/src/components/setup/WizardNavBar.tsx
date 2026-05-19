import { Button } from "react-aria-components";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { WIZARD_SECTIONS, SECTION_LABELS, type WizardSection } from "./wizardReducer";

interface WizardNavBarProps {
  currentSection: WizardSection;
  currentSubStep: string | null;
  prevSubStep: { section: WizardSection; subStep: string | null } | null;
  /** Optional override for the back button label (e.g. resolved tool name instead of raw key) */
  prevSubStepLabel?: string | null;
  onBack: () => void;
  onContinue: () => void;
}

export default function WizardNavBar({
  currentSection,
  currentSubStep,
  prevSubStep,
  prevSubStepLabel,
  onBack,
  onContinue,
}: WizardNavBarProps) {
  const currentIndex = WIZARD_SECTIONS.indexOf(currentSection);
  const nextSection =
    currentIndex < WIZARD_SECTIONS.length - 1 ? WIZARD_SECTIONS[currentIndex + 1] : null;
  const prevSection = currentIndex > 0 ? WIZARD_SECTIONS[currentIndex - 1] : null;

  // Show back if on a sub-step or there's a previous section
  const showBack = prevSubStep !== null || prevSection !== null;

  const defaultBackLabel = prevSubStep
    ? prevSubStep.subStep !== null
      ? prevSubStep.subStep
      : SECTION_LABELS[prevSubStep.section]
    : prevSection
      ? SECTION_LABELS[prevSection]
      : null;
  const backLabel = prevSubStepLabel ?? defaultBackLabel;

  const isLastBeforeReview = nextSection === "review";
  const nextLabel = isLastBeforeReview && currentSubStep === null ? "Review" : "Continue";

  return (
    <div className="mt-10 pt-6 border-t border-stone-200 dark:border-stone-800/50 flex items-center justify-between">
      {showBack && backLabel ? (
        <Button
          onPress={onBack}
          className="text-sm text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors flex items-center gap-1.5 pressed:text-stone-400"
        >
          <ArrowLeft size={14} />
          {backLabel}
        </Button>
      ) : (
        <span />
      )}

      {nextSection && (
        <Button
          onPress={onContinue}
          className="text-sm px-4 py-2 rounded-md bg-amber-500 text-stone-950 hover:bg-amber-400 transition-colors font-medium flex items-center gap-1.5 pressed:bg-amber-600"
        >
          {nextLabel}
          <ArrowRight size={14} />
        </Button>
      )}
    </div>
  );
}
