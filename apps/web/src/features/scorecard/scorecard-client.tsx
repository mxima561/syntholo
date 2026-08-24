"use client";

import { ArrowLeft, ArrowRight, Check, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { calculateScore, dimensionLabels } from "./scoring";
import { scoreOptions, scorecardQuestions } from "./questions";

type AssessmentStage = "questions" | "preview" | "report";

export function ScorecardClient() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [stage, setStage] = useState<AssessmentStage>("questions");
  const question = scorecardQuestions[currentIndex];
  const result = calculateScore(answers);

  function chooseAnswer(value: number, target?: HTMLButtonElement) {
    target?.blur();
    setAnswers((current) => ({ ...current, [question.id]: value }));
    if (currentIndex === scorecardQuestions.length - 1) {
      setStage("preview");
      return;
    }
    setCurrentIndex((index) => index + 1);
  }

  function goBack() {
    setCurrentIndex((index) => Math.max(0, index - 1));
  }

  if (stage === "report") {
    return (
      <section className="scorecard-report" aria-labelledby="report-title">
        <div className="report-summary">
          <div className="score-orbit"><span><strong>{result.overall}</strong>/ 100</span></div>
          <div>
            <span className="micro-label">YOUR READINESS REPORT</span>
            <h1 id="report-title">You are in the {result.band.toLowerCase()} stage.</h1>
            <p>Your strongest base is {dimensionLabels[result.strongestDimension].toLowerCase()}. Your clearest first win is the {result.recommendedWorkflow.toLowerCase()} workflow.</p>
          </div>
        </div>
        <div className="dimension-list">
          {Object.entries(result.dimensionScores).map(([dimension, score]) => (
            <div className="dimension-row" key={dimension}>
              <span>{dimensionLabels[dimension as keyof typeof dimensionLabels]}</span>
              <div className="dimension-track"><i style={{ width: `${score}%` }} /></div>
              <strong>{score}</strong>
            </div>
          ))}
        </div>
        <div className="report-action-grid">
          <article><span>01</span><h2>Start with one workflow</h2><p>Map the trigger, owner, human review point, and the result you will measure.</p></article>
          <article><span>02</span><h2>Make safety visible</h2><p>List approved tools and decide which data never enters an AI system.</p></article>
          <article><span>03</span><h2>Bring one teammate</h2><p>Choose the person closest to the work and build the first version together.</p></article>
        </div>
        <div className="report-cta">
          <div><span className="micro-label light">RECOMMENDED NEXT STEP</span><h2>Install your AI operating rhythm in 30 days.</h2></div>
          <Button href="/pricing" size="large" variant="secondary">See the academy <ArrowRight aria-hidden size={17} /></Button>
        </div>
      </section>
    );
  }

  if (stage === "preview") {
    return (
      <section className="scorecard-preview" aria-labelledby="preview-title">
        <div className="score-orbit"><span><strong>{result.overall}</strong>/ 100</span></div>
        <span className="micro-label">YOUR SCORE PREVIEW</span>
        <h1 id="preview-title">Your business is {result.band.toLowerCase()}.</h1>
        <p>Unlock the five-dimension breakdown, two priority gaps, and your recommended first workflow.</p>
        <form
          className="report-gate"
          onSubmit={(event) => {
            event.preventDefault();
            setStage("report");
          }}
        >
          <div className="field-grid">
            <label>First name<input name="firstName" placeholder="Maria" required /></label>
            <label>Work email<input name="email" placeholder="maria@company.com" required type="email" /></label>
          </div>
          <div className="field-grid">
            <label>Business name<input name="business" placeholder="Example Advisory" required /></label>
            <label>Country<select defaultValue="" name="country" required><option disabled value="">Select country</option><option>United States</option><option>Canada</option><option>United Kingdom</option><option>Australia</option><option>Other</option></select></label>
          </div>
          <label className="consent-row"><input name="marketing" type="checkbox" /> Send me practical AI implementation notes. Optional, unsubscribe anytime.</label>
          <Button size="large" type="submit">Unlock my full report <ArrowRight aria-hidden size={17} /></Button>
          <p className="privacy-note"><LockKeyhole aria-hidden size={13} /> Your report is private. Marketing consent is optional.</p>
        </form>
      </section>
    );
  }

  return (
    <section className="scorecard-workspace" aria-labelledby="question-title">
      <div className="scorecard-meta">
        <span>Question {currentIndex + 1} of {scorecardQuestions.length}</span>
        <span>{dimensionLabels[question.dimension]}</span>
      </div>
      <div className="scorecard-progress" aria-hidden><i style={{ width: `${((currentIndex + 1) / scorecardQuestions.length) * 100}%` }} /></div>
      <div className="question-card">
        <span className="micro-label">{dimensionLabels[question.dimension]}</span>
        <h1 id="question-title">{question.prompt}</h1>
        <p>{question.context}</p>
        <div className="answer-list">
          {scoreOptions.map((option) => (
            <button
              aria-pressed={answers[question.id] === option.value}
              className={`answer-option ${answers[question.id] === option.value ? "selected" : ""}`}
              key={`${question.id}-${option.value}`}
              onClick={(event) => chooseAnswer(option.value, event.currentTarget)}
              type="button"
            >
              <span>{option.value}</span><strong>{option.label}</strong>
              {answers[question.id] === option.value ? <span className="answer-status"><Check aria-hidden size={16} /> Selected</span> : <Check aria-hidden size={16} />}
            </button>
          ))}
        </div>
      </div>
      <div className="scorecard-footer">
        <button className="back-button" disabled={currentIndex === 0} onClick={goBack} type="button"><ArrowLeft aria-hidden size={15} /> Back</button>
        <span>About 6 minutes · Answers save as you go</span>
      </div>
    </section>
  );
}
