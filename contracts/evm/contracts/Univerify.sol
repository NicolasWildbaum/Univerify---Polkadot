// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal interface to the soulbound NFT minted on issuance. The
///         registry calls into it atomically from `issueCertificate` so the
///         student wallet receives the token in the same transaction.
///         `minter()` is also read at NFT-wire-up time to make sure the NFT
///         points back at this registry — the only sanity gate we keep now
///         that there is no privileged configurer.
interface ICertificateNft {
	function mintFor(address to, bytes32 certificateId) external returns (uint256);

	function minter() external view returns (address);
}

/// @title Univerify — Federated Academic Credential Registry
/// @notice Issuers are universities. A small set of **genesis** universities is
///         activated at deployment; new universities self-apply and enter a
///         pending waitlist. A candidate becomes Active once it is approved by
///         at least `approvalThreshold` already-Active universities. Only
///         Active universities can issue or revoke certificates.
///
///         Governance is fully federated and there is no privileged account.
///         Active universities collectively onboard new applicants (`apply` +
///         `approve`) and can also remove one another through a decentralized
///         removal-proposal flow (`proposeRemoval` + `voteForRemoval`). There
///         is no owner, no emergency suspend/unsuspend path, and no role that
///         can unilaterally alter the active set.
///
///         Verification is presentation-based: a verifier recomputes
///         `claimsHash` off-chain and calls `verifyCertificate`. No PII or
///         holder identity is stored on-chain — only the student's wallet
///         address as the recipient of the soulbound NFT minted by
///         `CertificateNft` (`certificateNft`).
contract Univerify {
	// ── Types ───────────────────────────────────────────────────────────

	/// @notice On-chain representation of an academic credential.
	/// @dev Holder binding is delegated to the soulbound NFT minted to the
	///      student's wallet by `CertificateNft`; the registry intentionally
	///      keeps no holder-identity material of its own.
	struct Certificate {
		address issuer;
		bytes32 claimsHash;
		uint256 issuedAt;
		bool revoked;
	}

	/// @notice Lifecycle of an issuing university.
	/// @dev `None` is the default (zero) value so an unknown address reads as
	///      `None` without an extra sentinel check. `Removed` is **not**
	///      terminal: a removed issuer may re-apply through `applyAsIssuer`,
	///      which transitions them back to `Pending` and invalidates any
	///      approvals collected in a prior round via `issuerEpoch`. The slot
	///      is kept in `_issuerList` for historical lookups either way, so
	///      re-application never duplicates the enumeration entry.
	enum IssuerStatus {
		None,
		Pending,
		Active,
		Removed
	}

	/// @notice Full on-chain profile of an issuing university.
	/// @dev `name` is kept on-chain to make the waitlist and verification UIs
	///      self-contained without requiring an off-chain metadata resolver.
	///      Its length is bounded by `MAX_NAME_LENGTH` to cap storage cost.
	struct Issuer {
		address account;
		IssuerStatus status;
		bytes32 metadataHash;
		string name;
		uint64 registeredAt;
		uint32 approvalCount;
	}

	/// @notice Constructor-only descriptor for a genesis university.
	struct GenesisIssuer {
		address account;
		string name;
		bytes32 metadataHash;
	}

	/// @notice On-chain state of a pending or executed removal proposal.
	/// @dev `createdAt` is stored for UI ordering and potential off-chain
	///      audit trails; it is not used for any on-chain expiry (none).
	struct RemovalProposal {
		address target;
		address proposer;
		uint64 createdAt;
		uint32 voteCount;
		bool executed;
	}

	// ── Errors ──────────────────────────────────────────────────────────

	error NotActiveIssuer();

	error ZeroAddress();
	error EmptyName();
	error NameTooLong();
	error IssuerAlreadyExists();
	error IssuerNotFound();
	error IssuerNotPending();
	error IssuerNotActive();
	error CannotApproveSelf();
	error AlreadyApproved();

	error InvalidThreshold();
	error InvalidGenesis();

	// Removal-governance errors
	error CannotProposeSelfRemoval();
	error RemovalProposalAlreadyOpen();
	error RemovalProposalNotFound();
	error RemovalProposalAlreadyExecuted();
	error AlreadyVotedForRemoval();
	error CannotVoteOnOwnRemoval();

	error InvalidCertificateId();
	error InvalidClaimsHash();
	error InvalidStudentAddress();
	error CertificateAlreadyExists();
	error CertificateNotFound();
	error CertificateAlreadyRevoked();
	error NotCertificateIssuer();

	error NftAlreadySet();
	error NftNotConfigured();
	error NftMinterMismatch();

	// ── Constants ───────────────────────────────────────────────────────

	/// @notice Maximum byte length of an issuer's on-chain `name`.
	/// @dev Keeps storage bounded and protects against pathological names.
	uint256 public constant MAX_NAME_LENGTH = 64;

	// ── State ───────────────────────────────────────────────────────────

	/// @notice Minimum number of approvals from Active universities required
	///         to promote a Pending applicant to Active. The same threshold
	///         also governs removal: a removal proposal executes once its
	///         vote count reaches `approvalThreshold` votes from currently
	///         Active issuers. Set once at deploy.
	/// @dev    A single threshold for both admission and removal keeps the
	///         federation trust level symmetric. Trade-off: if the number of
	///         Active issuers ever drops below `approvalThreshold`, both
	///         paths stall and governance is degenerate. MVP accepts this as
	///         a redeploy condition rather than encoding a dynamic majority.
	uint32 public immutable approvalThreshold;

	/// @notice Count of currently Active issuers. Incremented when a Pending
	///         applicant is promoted, decremented when an Active issuer is
	///         removed by governance. Exposed so the frontend can render
	///         threshold status without scanning `_issuerList`.
	uint32 public activeIssuerCount;

	/// @dev Primary issuer storage. Unknown addresses read as `{status: None}`.
	mapping(address => Issuer) private _issuers;

	/// @dev Append-only enumeration of every issuer that has ever applied or
	///      been seeded at genesis. Frontends read this list and filter by
	///      `status` to render the waitlist / active set. No removals means
	///      no swap-and-pop complexity and no storage gaps. A `Removed`
	///      issuer still appears in this list with `status = Removed`.
	address[] private _issuerList;

	/// @notice Per-issuer re-application round. Starts at 0 for every address
	///         and is incremented each time a Removed issuer re-enters the
	///         Pending waitlist via `applyAsIssuer`. Because approval records
	///         are keyed by `(candidate, epoch, approver)`, bumping the
	///         epoch atomically clears the entire approval ledger of the
	///         previous round without any storage iteration.
	/// @dev    Public for UI transparency (an applicant's "this is attempt
	///         N+1" label) and to make the re-application semantics
	///         observable off-chain. Genesis issuers are on epoch 0; they
	///         only acquire a non-zero epoch if they are removed and later
	///         re-apply.
	mapping(address => uint32) public issuerEpoch;

	/// @dev Approval tracking, namespaced by `issuerEpoch[candidate]` so that
	///      approvals from a prior round cannot bleed into a re-application.
	///      Keyed candidate => epoch => approver => approved? Used to prevent
	///      double approvals and to power `hasApproved()`.
	mapping(address => mapping(uint32 => mapping(address => bool))) private _hasApproved;

	/// @notice Monotonically increasing counter used as proposal id. The
	///         first proposal minted is id 1, so `0` is a reserved sentinel
	///         meaning "no proposal" (used by `openRemovalProposal`).
	uint256 public removalProposalCount;

	/// @dev Proposal storage keyed by proposal id. Unknown ids read as a
	///      zeroed struct (target == address(0)) — treated as "not found".
	mapping(uint256 => RemovalProposal) private _removalProposals;

	/// @dev Per-proposal voting ledger: proposalId => voter => voted?
	mapping(uint256 => mapping(address => bool)) private _hasVotedOnRemoval;

	/// @notice Currently-open removal proposal id for a given target, or `0`
	///         if none. Used to enforce "at most one active removal proposal
	///         per target" and to let the frontend discover proposals by
	///         target without iterating history.
	mapping(address => uint256) public openRemovalProposal;

	/// @notice Certificates keyed by `certificateId`.
	mapping(bytes32 => Certificate) public certificates;

	/// @notice Soulbound NFT contract that mirrors certificate ownership in
	///         the student's wallet. Wired exactly once, post-deploy, by any
	///         caller via `setCertificateNft` (see that function for the
	///         trust model — the permissionless one-shot is guarded by a
	///         minter-matches-self sanity check).
	address public certificateNft;

	// ── Events ──────────────────────────────────────────────────────────

	event IssuerApplied(address indexed issuer, string name, bytes32 metadataHash);
	event IssuerApproved(address indexed approver, address indexed issuer, uint32 approvalCount);
	event IssuerActivated(address indexed issuer);

	event RemovalProposalCreated(
		uint256 indexed proposalId,
		address indexed target,
		address indexed proposer
	);
	event RemovalVoteCast(uint256 indexed proposalId, address indexed voter, uint32 voteCount);
	event IssuerRemoved(address indexed issuer, uint256 indexed proposalId);

	event CertificateIssued(
		bytes32 indexed certificateId,
		address indexed issuer,
		address indexed student
	);
	event CertificateRevoked(bytes32 indexed certificateId, address indexed issuer);
	event CertificateNftSet(address indexed nft);

	// ── Modifiers ───────────────────────────────────────────────────────

	modifier onlyActiveIssuer() {
		if (_issuers[msg.sender].status != IssuerStatus.Active) revert NotActiveIssuer();
		_;
	}

	// ── Constructor ─────────────────────────────────────────────────────

	/// @notice Bootstrap the registry with a set of genesis universities that
	///         are Active from block zero.
	/// @param  genesis   Non-empty list of genesis universities.
	/// @param  threshold Number of Active-issuer approvals required to promote
	///                   a future Pending applicant to Active, and also the
	///                   number of Active-issuer votes required to remove an
	///                   Active issuer. Must satisfy
	///                   `1 <= threshold <= genesis.length` so that at least
	///                   one onboarding path exists from day one.
	constructor(GenesisIssuer[] memory genesis, uint32 threshold) {
		if (threshold == 0) revert InvalidThreshold();
		if (genesis.length == 0 || threshold > genesis.length) revert InvalidGenesis();

		approvalThreshold = threshold;

		for (uint256 i = 0; i < genesis.length; i++) {
			GenesisIssuer memory g = genesis[i];
			if (g.account == address(0)) revert ZeroAddress();
			_validateName(g.name);
			if (_issuers[g.account].status != IssuerStatus.None) revert IssuerAlreadyExists();

			_issuers[g.account] = Issuer({
				account: g.account,
				status: IssuerStatus.Active,
				metadataHash: g.metadataHash,
				name: g.name,
				registeredAt: uint64(block.timestamp),
				approvalCount: 0
			});
			_issuerList.push(g.account);
			emit IssuerActivated(g.account);
		}
		activeIssuerCount = uint32(genesis.length);
	}

	// ── Governance: Application & Approval ──────────────────────────────

	/// @notice Self-apply to join the registry as a university. The caller's
	///         address becomes the issuer identity. Starts in `Pending`.
	/// @dev    Also the re-application entrypoint: a `Removed` caller may
	///         call this again to re-enter the waitlist. In that case the
	///         enumeration slot is reused (no `_issuerList.push`), the
	///         profile fields are overwritten with the new `name` and
	///         `metadataHash`, `approvalCount` is reset to 0, and
	///         `issuerEpoch[msg.sender]` is bumped so that approvals from
	///         the previous round cannot count toward this one. `Pending`
	///         and `Active` callers remain rejected with `IssuerAlreadyExists`.
	/// @param  name          Human-readable institution name (1..MAX_NAME_LENGTH bytes).
	/// @param  metadataHash  Off-chain metadata commitment (DID doc, IPFS CID,
	///                       etc.). Not resolved on-chain.
	function applyAsIssuer(string calldata name, bytes32 metadataHash) external {
		_validateName(name);
		IssuerStatus prev = _issuers[msg.sender].status;
		if (prev == IssuerStatus.Pending || prev == IssuerStatus.Active) {
			revert IssuerAlreadyExists();
		}

		if (prev == IssuerStatus.Removed) {
			// Re-application: bump the approval round so prior votes can't
			// leak in, and keep the existing `_issuerList` slot so the
			// enumeration remains append-only.
			issuerEpoch[msg.sender] += 1;
		} else {
			// First-time applicant: extend the enumeration.
			_issuerList.push(msg.sender);
		}

		_issuers[msg.sender] = Issuer({
			account: msg.sender,
			status: IssuerStatus.Pending,
			metadataHash: metadataHash,
			name: name,
			registeredAt: uint64(block.timestamp),
			approvalCount: 0
		});

		emit IssuerApplied(msg.sender, name, metadataHash);
	}

	/// @notice Approve a Pending university. Only Active universities can
	///         approve, and only once per candidate. Reaching the threshold
	///         promotes the candidate to Active atomically in the same tx.
	/// @param  candidate Address of the Pending applicant.
	function approveIssuer(address candidate) external onlyActiveIssuer {
		if (candidate == msg.sender) revert CannotApproveSelf();

		Issuer storage c = _issuers[candidate];
		if (c.status != IssuerStatus.Pending) revert IssuerNotPending();
		uint32 epoch = issuerEpoch[candidate];
		if (_hasApproved[candidate][epoch][msg.sender]) revert AlreadyApproved();

		_hasApproved[candidate][epoch][msg.sender] = true;
		uint32 newCount = c.approvalCount + 1;
		c.approvalCount = newCount;

		emit IssuerApproved(msg.sender, candidate, newCount);

		if (newCount >= approvalThreshold) {
			c.status = IssuerStatus.Active;
			activeIssuerCount += 1;
			emit IssuerActivated(candidate);
		}
	}

	// ── Governance: Removal ─────────────────────────────────────────────

	/// @notice Open a removal proposal against an Active issuer. The
	///         proposer's own vote is counted as the first vote, so a
	///         proposal starts with `voteCount == 1`. If that already meets
	///         `approvalThreshold` (e.g. threshold of 1), removal executes
	///         in the same transaction.
	/// @dev    Self-proposal is disallowed on purpose: an Active issuer that
	///         wants to step down can simply stop acting; there is no
	///         on-chain "resign" path in this MVP. Forcing removal through
	///         another proposer keeps the flow symmetric with admission.
	/// @param  target Active issuer to propose for removal.
	/// @return proposalId The new proposal id (always > 0).
	function proposeRemoval(
		address target
	) external onlyActiveIssuer returns (uint256 proposalId) {
		if (target == msg.sender) revert CannotProposeSelfRemoval();
		Issuer storage t = _issuers[target];
		if (t.status == IssuerStatus.None) revert IssuerNotFound();
		if (t.status != IssuerStatus.Active) revert IssuerNotActive();
		if (openRemovalProposal[target] != 0) revert RemovalProposalAlreadyOpen();

		proposalId = ++removalProposalCount;
		_removalProposals[proposalId] = RemovalProposal({
			target: target,
			proposer: msg.sender,
			createdAt: uint64(block.timestamp),
			voteCount: 1,
			executed: false
		});
		_hasVotedOnRemoval[proposalId][msg.sender] = true;
		openRemovalProposal[target] = proposalId;

		emit RemovalProposalCreated(proposalId, target, msg.sender);
		emit RemovalVoteCast(proposalId, msg.sender, 1);

		_maybeExecuteRemoval(proposalId);
	}

	/// @notice Cast a vote in favour of an open removal proposal. Only
	///         currently-Active issuers may vote, at most once per proposal,
	///         and the target of the proposal cannot vote on their own
	///         removal. When the vote count reaches `approvalThreshold` the
	///         target is demoted to `Removed` atomically in the same tx.
	/// @dev    We intentionally do NOT retroactively decrement vote counts
	///         when a prior voter is itself later removed. Each vote was
	///         valid at the moment it was cast by an Active issuer, and
	///         re-tallying history would add complexity without changing
	///         the trust model in a meaningful way.
	function voteForRemoval(uint256 proposalId) external onlyActiveIssuer {
		RemovalProposal storage p = _removalProposals[proposalId];
		if (p.target == address(0)) revert RemovalProposalNotFound();
		if (p.executed) revert RemovalProposalAlreadyExecuted();
		if (msg.sender == p.target) revert CannotVoteOnOwnRemoval();
		if (_hasVotedOnRemoval[proposalId][msg.sender]) revert AlreadyVotedForRemoval();

		_hasVotedOnRemoval[proposalId][msg.sender] = true;
		uint32 newCount = p.voteCount + 1;
		p.voteCount = newCount;

		emit RemovalVoteCast(proposalId, msg.sender, newCount);

		_maybeExecuteRemoval(proposalId);
	}

	/// @dev Execute removal if threshold reached. Internal to keep the
	///      post-vote side-effects (status flip, counter updates, event)
	///      identical whether the triggering call was `proposeRemoval` or
	///      `voteForRemoval`.
	function _maybeExecuteRemoval(uint256 proposalId) private {
		RemovalProposal storage p = _removalProposals[proposalId];
		if (p.voteCount >= approvalThreshold) {
			p.executed = true;
			_issuers[p.target].status = IssuerStatus.Removed;
			activeIssuerCount -= 1;
			delete openRemovalProposal[p.target];
			emit IssuerRemoved(p.target, proposalId);
		}
	}

	// ── NFT wiring ──────────────────────────────────────────────────────

	/// @notice Wire up the soulbound `CertificateNft` contract. One-shot and
	///         permissionless: any caller may invoke it exactly once, and
	///         only if the passed NFT's immutable `minter()` already points
	///         back at this registry. The minter check is the security
	///         backstop — an NFT wired here can only ever be minted by this
	///         Univerify's `issueCertificate`, so a mis-wiring can at worst
	///         deny service and require a redeploy, never corrupt issuance
	///         or governance state.
	/// @dev    We keep this as a separate setter (rather than a constructor
	///         argument) to avoid the circular dependency between the two
	///         contracts at construction time: the NFT needs Univerify's
	///         address in its constructor, and Univerify needs the NFT's.
	function setCertificateNft(address nft) external {
		if (nft == address(0)) revert ZeroAddress();
		if (certificateNft != address(0)) revert NftAlreadySet();
		if (ICertificateNft(nft).minter() != address(this)) revert NftMinterMismatch();
		certificateNft = nft;
		emit CertificateNftSet(nft);
	}

	// ── Certificate Lifecycle ───────────────────────────────────────────

	/// @notice Issue a new verifiable credential record and mint the
	///         corresponding soulbound NFT to the student's wallet
	///         atomically. Only Active issuers may call.
	/// @param  studentAddress Wallet that receives the soulbound NFT. The
	///                        registry continues to omit any PII; the wallet
	///                        is the only on-chain link to the holder.
	function issueCertificate(
		bytes32 certificateId,
		bytes32 claimsHash,
		address studentAddress
	) external onlyActiveIssuer returns (bytes32) {
		if (certificateId == bytes32(0)) revert InvalidCertificateId();
		if (claimsHash == bytes32(0)) revert InvalidClaimsHash();
		if (studentAddress == address(0)) revert InvalidStudentAddress();
		if (certificates[certificateId].issuer != address(0)) revert CertificateAlreadyExists();
		address nft = certificateNft;
		if (nft == address(0)) revert NftNotConfigured();

		certificates[certificateId] = Certificate({
			issuer: msg.sender,
			claimsHash: claimsHash,
			issuedAt: block.timestamp,
			revoked: false
		});

		emit CertificateIssued(certificateId, msg.sender, studentAddress);

		// Atomic mint: any failure on the NFT side reverts the entire
		// issuance, so registry state and NFT supply can never diverge.
		ICertificateNft(nft).mintFor(studentAddress, certificateId);

		return certificateId;
	}

	/// @notice Revoke a certificate. Only the original issuer, and only while
	///         still Active, may revoke. An issuer removed by governance
	///         cannot revoke their own past certificates — the federation
	///         has withdrawn their right to act.
	function revokeCertificate(bytes32 certificateId) external onlyActiveIssuer {
		if (certificateId == bytes32(0)) revert InvalidCertificateId();

		Certificate storage cert = certificates[certificateId];
		if (cert.issuer == address(0)) revert CertificateNotFound();
		if (cert.issuer != msg.sender) revert NotCertificateIssuer();
		if (cert.revoked) revert CertificateAlreadyRevoked();

		cert.revoked = true;
		emit CertificateRevoked(certificateId, msg.sender);
	}

	// ── Verification ────────────────────────────────────────────────────

	/// @notice Presentation-based verification entrypoint. Returns all fields
	///         a verifier needs to make a trust decision off-chain.
	function verifyCertificate(
		bytes32 certificateId,
		bytes32 claimsHash
	)
		external
		view
		returns (bool exists, address issuer, bool hashMatch, bool revoked, uint256 issuedAt)
	{
		Certificate memory cert = certificates[certificateId];
		exists = cert.issuer != address(0);
		if (!exists) return (false, address(0), false, false, 0);

		issuer = cert.issuer;
		hashMatch = cert.claimsHash == claimsHash;
		revoked = cert.revoked;
		issuedAt = cert.issuedAt;
	}

	// ── Read Helpers ────────────────────────────────────────────────────

	/// @notice Full issuer profile. Returns a zeroed struct (`status = None`)
	///         for addresses that have never applied or been seeded.
	function getIssuer(address account) external view returns (Issuer memory) {
		return _issuers[account];
	}

	/// @notice Convenience gate for the frontend and for off-chain verifiers.
	function isActiveIssuer(address account) external view returns (bool) {
		return _issuers[account].status == IssuerStatus.Active;
	}

	/// @notice Whether a given Active issuer has already approved a candidate
	///         **in the current application round** (i.e. for
	///         `issuerEpoch[candidate]`). Approvals from previous rounds —
	///         before a prior removal — are intentionally not surfaced here
	///         so the UI always reflects the live, actionable state. Enables
	///         the frontend to disable an already-used approval button
	///         without replaying events.
	function hasApproved(address candidate, address approver) external view returns (bool) {
		return _hasApproved[candidate][issuerEpoch[candidate]][approver];
	}

	/// @notice Total number of known issuers (any status).
	function issuerCount() external view returns (uint256) {
		return _issuerList.length;
	}

	/// @notice Nth known issuer address, for paginated reads.
	function issuerAt(uint256 index) external view returns (address) {
		return _issuerList[index];
	}

	// ── Read Helpers: Removal Governance ────────────────────────────────

	/// @notice Full proposal record by id. Unknown ids return a zeroed
	///         struct (`target == address(0)`) which the frontend treats as
	///         "not found".
	function getRemovalProposal(
		uint256 proposalId
	) external view returns (RemovalProposal memory) {
		return _removalProposals[proposalId];
	}

	/// @notice Whether a voter has already voted on a specific proposal.
	function hasVotedOnRemoval(
		uint256 proposalId,
		address voter
	) external view returns (bool) {
		return _hasVotedOnRemoval[proposalId][voter];
	}

	// ── Internal ────────────────────────────────────────────────────────

	function _validateName(string memory name) internal pure {
		bytes memory b = bytes(name);
		if (b.length == 0) revert EmptyName();
		if (b.length > MAX_NAME_LENGTH) revert NameTooLong();
	}
}
