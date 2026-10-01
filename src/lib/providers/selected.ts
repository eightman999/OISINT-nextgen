// This is the safe fallback for tools that do not load Metro's conditional resolver.
// Metro maps this module to mock.ts only for explicitly allowed mock builds.
export {
  provider,
  isLiveDataProvider,
  getInvestigationSync,
  getInvestigationByShareTokenSync,
  setVoteForUser,
  addRequirementForUser,
  removeRequirementForUser,
  rotateShareTokenForUser,
} from './live';
