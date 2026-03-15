import * as anchor from "@coral-xyz/anchor";
import { BN, Wallet, web3 } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, createMint, mintTo } from "@solana/spl-token";
import {
  GOVERN_PROGRAM_ID,
  IProposalInstruction,
  SMART_WALLET_PROGRAM_ID,
  LOCKED_VOTER_PROGRAM_ID,
  createAndFundWallet,
  createGovernProgram,
  createGovernor,
  createSmartWallet,
  createSmartWalletProgram,
  createLockedVoterProgram,
  deriveEscrow,
  deriveGovern,
  deriveLocker,
  deriveSmartWallet,
  deriveTransaction,
  getOrCreateATA,
  invokeAndAssertError,
} from "../utils";
import { expect } from "chai";

const provider = anchor.AnchorProvider.env();

const lockAmount = new BN(1000);
const instantUnstakeAmount = new BN(400);
const defaultPenaltyBps = 2500;

describe("Instant unstake", () => {
  let locker: web3.PublicKey;
  let govern: web3.PublicKey;
  let smartWallet: web3.PublicKey;
  let instantUnstakeConfig: web3.PublicKey;

  let wallet: Wallet;
  let keypair: web3.Keypair;

  let rewardMint: web3.PublicKey;
  let feeRecipientKeypair: web3.Keypair;
  let secondFeeRecipientKeypair: web3.Keypair;

  // Smart wallet config
  let smartWalletOwners: web3.PublicKey[] = [];
  let smartWalletThreshold: BN = new BN(1);

  // Govern config
  const votingPeriod: BN = new BN(10);
  const quorumVotes: BN = new BN(2);

  // Voter config
  const maxStakeDuration: BN = new BN(20);
  const minStakeDuration: BN = new BN(10);
  const maxStakeVoteMultiplier: number = 1;
  const proposalActivationMinVotes: BN = new BN(2);

  function deriveInstantUnstakeConfig(lockerKey: web3.PublicKey) {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from("InstantUnstakeConfig"), lockerKey.toBytes()],
      LOCKED_VOTER_PROGRAM_ID
    );
  }

  async function initializeLocker() {
    const voterProgram = createLockedVoterProgram(
      wallet,
      LOCKED_VOTER_PROGRAM_ID
    );
    await voterProgram.methods
      .newLocker({
        maxStakeDuration,
        maxStakeVoteMultiplier,
        minStakeDuration,
        proposalActivationMinVotes,
      })
      .accounts({
        base: keypair.publicKey,
        locker,
        tokenMint: rewardMint,
        governor: govern,
        payer: voterProgram.provider.publicKey,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
  }

  async function executeViaSmartWallet(ix: IProposalInstruction) {
    const smartWalletProgram = createSmartWalletProgram(
      wallet,
      SMART_WALLET_PROGRAM_ID
    );
    const smartWalletState = await smartWalletProgram.account.smartWallet.fetch(
      smartWallet
    );
    const [transaction, txBump] = deriveTransaction(
      smartWallet,
      smartWalletState.numTransactions
    );

    await smartWalletProgram.methods
      .createTransaction(txBump, [ix])
      .accounts({
        payer: smartWalletProgram.provider.publicKey,
        proposer: smartWalletProgram.provider.publicKey,
        smartWallet,
        systemProgram: web3.SystemProgram.programId,
        transaction,
      })
      .rpc();

    return await smartWalletProgram.methods
      .executeTransaction()
      .accounts({
        owner: smartWalletProgram.provider.publicKey,
        smartWallet,
        transaction,
      })
      .remainingAccounts([
        {
          isSigner: false,
          isWritable: false,
          pubkey: LOCKED_VOTER_PROGRAM_ID,
        },
        ...ix.keys.map((x) => {
          return {
            ...x,
            isSigner: false,
          };
        }),
      ])
      .rpc();
  }

  async function initInstantUnstakeConfigByGovernance(
    enabled: boolean,
    instantPenaltyBps: number,
    feeRecipient: web3.PublicKey
  ) {
    const voterProgram = createLockedVoterProgram(
      wallet,
      LOCKED_VOTER_PROGRAM_ID
    );
    const ixData = voterProgram.coder.instruction.encode(
      "init_instant_unstake_config",
      {
        params: {
          enabled,
          instantPenaltyBps,
          feeRecipient,
        },
      }
    );

    const ix: IProposalInstruction = {
      data: ixData,
      programId: LOCKED_VOTER_PROGRAM_ID,
      keys: [
        {
          isSigner: false,
          isWritable: true,
          pubkey: locker,
        },
        {
          isSigner: false,
          isWritable: true,
          pubkey: instantUnstakeConfig,
        },
        {
          isSigner: false,
          isWritable: false,
          pubkey: govern,
        },
        {
          isSigner: true,
          isWritable: false,
          pubkey: smartWallet,
        },
        {
          isSigner: true,
          isWritable: true,
          pubkey: wallet.publicKey,
        },
        {
          isSigner: false,
          isWritable: false,
          pubkey: web3.SystemProgram.programId,
        },
      ],
    };

    return await executeViaSmartWallet(ix);
  }

  async function setInstantUnstakeParamsByGovernance(params: any) {
    const voterProgram = createLockedVoterProgram(
      wallet,
      LOCKED_VOTER_PROGRAM_ID
    );
    const ixData = voterProgram.coder.instruction.encode(
      "set_instant_unstake_params",
      {
        params,
      }
    );

    const ix: IProposalInstruction = {
      data: ixData,
      programId: LOCKED_VOTER_PROGRAM_ID,
      keys: [
        {
          isSigner: false,
          isWritable: false,
          pubkey: locker,
        },
        {
          isSigner: false,
          isWritable: true,
          pubkey: instantUnstakeConfig,
        },
        {
          isSigner: false,
          isWritable: false,
          pubkey: govern,
        },
        {
          isSigner: true,
          isWritable: false,
          pubkey: smartWallet,
        },
      ],
    };

    return await executeViaSmartWallet(ix);
  }

  async function createFundedUserEscrow(amount: BN) {
    const result = await createAndFundWallet(provider.connection);
    const userKeypair = result.keypair;
    const userWallet = result.wallet;
    const voterProgram = createLockedVoterProgram(
      userWallet,
      LOCKED_VOTER_PROGRAM_ID
    );
    const [escrow, _bump] = deriveEscrow(
      locker,
      userWallet.publicKey,
      LOCKED_VOTER_PROGRAM_ID
    );

    await voterProgram.methods
      .newEscrow()
      .accounts({
        escrow,
        escrowOwner: userWallet.publicKey,
        locker,
        payer: userWallet.publicKey,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    await voterProgram.methods
      .extendLockDuration(maxStakeDuration)
      .accounts({
        escrow,
        escrowOwner: userWallet.publicKey,
        locker,
      })
      .rpc();

    const escrowATA = await getOrCreateATA(
      rewardMint,
      escrow,
      keypair,
      provider.connection
    );

    const userATA = await getOrCreateATA(
      rewardMint,
      userWallet.publicKey,
      userKeypair,
      provider.connection
    );

    await mintTo(
      provider.connection,
      keypair,
      rewardMint,
      userATA,
      keypair.publicKey,
      amount.toNumber()
    );

    await voterProgram.methods
      .increaseLockedAmount(amount)
      .accounts({
        escrow,
        escrowTokens: escrowATA,
        locker,
        payer: voterProgram.provider.publicKey,
        sourceTokens: userATA,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    return {
      escrow,
      escrowATA,
      userATA,
      userKeypair,
      userWallet,
      voterProgram,
    };
  }

  async function getTokenBalance(tokenAccount: web3.PublicKey) {
    const balance = await provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    return new BN(balance.value.amount);
  }

  before(async () => {
    const result = await createAndFundWallet(provider.connection);
    keypair = result.keypair;
    wallet = result.wallet;

    const [lockerPda, _lBump] = deriveLocker(
      keypair.publicKey,
      LOCKED_VOTER_PROGRAM_ID
    );
    locker = lockerPda;

    const [governPda, _gBump] = deriveGovern(keypair.publicKey);
    govern = governPda;

    const [smartWalletPda, _sBump] = deriveSmartWallet(keypair.publicKey);
    smartWallet = smartWalletPda;

    const [configPda, _configBump] = deriveInstantUnstakeConfig(locker);
    instantUnstakeConfig = configPda;

    smartWalletOwners.push(governPda);
    smartWalletOwners.push(wallet.publicKey);

    await createSmartWallet(
      smartWalletOwners,
      smartWalletOwners.length,
      new BN(0),
      smartWalletThreshold,
      keypair,
      createSmartWalletProgram(wallet, SMART_WALLET_PROGRAM_ID)
    );

    await createGovernor(
      new BN(0),
      votingPeriod,
      quorumVotes,
      new BN(0),
      keypair,
      smartWallet,
      createGovernProgram(wallet, GOVERN_PROGRAM_ID),
      LOCKED_VOTER_PROGRAM_ID
    );

    await web3.sendAndConfirmTransaction(
      provider.connection,
      new web3.Transaction().add(
        web3.SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: smartWallet,
          lamports: 5 * web3.LAMPORTS_PER_SOL,
        })
      ),
      [keypair]
    );

    rewardMint = await createMint(
      provider.connection,
      keypair,
      keypair.publicKey,
      null,
      9
    );

    const feeRecipientResult = await createAndFundWallet(provider.connection);
    feeRecipientKeypair = feeRecipientResult.keypair;

    const secondFeeRecipientResult = await createAndFundWallet(
      provider.connection
    );
    secondFeeRecipientKeypair = secondFeeRecipientResult.keypair;

    await initializeLocker();
  });

  it("governance initializes instant unstake config", async () => {
    await initInstantUnstakeConfigByGovernance(
      true,
      defaultPenaltyBps,
      feeRecipientKeypair.publicKey
    );

    const voterProgram = createLockedVoterProgram(
      wallet,
      LOCKED_VOTER_PROGRAM_ID
    );
    const configState = await voterProgram.account.instantUnstakeConfig.fetch(
      instantUnstakeConfig
    );

    expect(configState.locker.toString()).to.equal(locker.toString());
    expect(configState.enabled).to.equal(true);
    expect(configState.instantPenaltyBps).to.equal(defaultPenaltyBps);
    expect(configState.feeRecipient.toString()).to.equal(
      feeRecipientKeypair.publicKey.toString()
    );
  });

  it("governance updates instant unstake params", async () => {
    const voterProgram = createLockedVoterProgram(
      wallet,
      LOCKED_VOTER_PROGRAM_ID
    );

    await setInstantUnstakeParamsByGovernance({ disable: {} });
    {
      const configState = await voterProgram.account.instantUnstakeConfig.fetch(
        instantUnstakeConfig
      );
      expect(configState.enabled).to.equal(false);
    }
    await invokeAndAssertError(
      () => setInstantUnstakeParamsByGovernance({ disable: {} }),
      "Instant unstake is already disabled",
      true
    );

    await setInstantUnstakeParamsByGovernance({ enable: {} });
    {
      const configState = await voterProgram.account.instantUnstakeConfig.fetch(
        instantUnstakeConfig
      );
      expect(configState.enabled).to.equal(true);
    }

    await invokeAndAssertError(
      () => setInstantUnstakeParamsByGovernance({ enable: {} }),
      "Instant unstake is already enabled",
      true
    );

    await invokeAndAssertError(
      () => setInstantUnstakeParamsByGovernance({ penaltyBps: { 0: 10001 } }),
      "Penalty basis points exceeds maximum (10000)",
      true
    );

    await setInstantUnstakeParamsByGovernance({ penaltyBps: { 0: 500 } });
    {
      const configState = await voterProgram.account.instantUnstakeConfig.fetch(
        instantUnstakeConfig
      );
      expect(configState.instantPenaltyBps).to.equal(500);
    }

    await invokeAndAssertError(
      () =>
        setInstantUnstakeParamsByGovernance({
          feeRecipient: { 0: web3.PublicKey.default },
        }),
      "Invalid fee recipient",
      true
    );

    await setInstantUnstakeParamsByGovernance({
      feeRecipient: { 0: secondFeeRecipientKeypair.publicKey },
    });
    {
      const configState = await voterProgram.account.instantUnstakeConfig.fetch(
        instantUnstakeConfig
      );
      expect(configState.feeRecipient.toString()).to.equal(
        secondFeeRecipientKeypair.publicKey.toString()
      );
    }

    await setInstantUnstakeParamsByGovernance({
      penaltyBps: { 0: defaultPenaltyBps },
    });
    await setInstantUnstakeParamsByGovernance({
      feeRecipient: { 0: feeRecipientKeypair.publicKey },
    });
  });

  it("cannot instant unstake when disabled or with invalid amount", async () => {
    const user = await createFundedUserEscrow(lockAmount);

    const feeRecipientATA = await getOrCreateATA(
      rewardMint,
      feeRecipientKeypair.publicKey,
      keypair,
      provider.connection
    );

    await setInstantUnstakeParamsByGovernance({ disable: {} });

    await invokeAndAssertError(
      () =>
        user.voterProgram.methods
          .instantUnstake(new BN(100))
          .accounts({
            locker,
            escrow: user.escrow,
            config: instantUnstakeConfig,
            owner: user.userWallet.publicKey,
            escrowTokens: user.escrowATA,
            destinationTokens: user.userATA,
            feeRecipientTokens: feeRecipientATA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
      "Instant unstake is not enabled",
      true
    );

    await setInstantUnstakeParamsByGovernance({ enable: {} });

    await invokeAndAssertError(
      () =>
        user.voterProgram.methods
          .instantUnstake(new BN(0))
          .accounts({
            locker,
            escrow: user.escrow,
            config: instantUnstakeConfig,
            owner: user.userWallet.publicKey,
            escrowTokens: user.escrowATA,
            destinationTokens: user.userATA,
            feeRecipientTokens: feeRecipientATA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
      "Amount is zero",
      true
    );
  });

  it("users instant unstake with zero penalty", async () => {
    const user = await createFundedUserEscrow(lockAmount);
    const feeRecipientATA = await getOrCreateATA(
      rewardMint,
      feeRecipientKeypair.publicKey,
      keypair,
      provider.connection
    );

    await setInstantUnstakeParamsByGovernance({ enable: {} }).catch(
      () => undefined
    );
    await setInstantUnstakeParamsByGovernance({ penaltyBps: { 0: 0 } });
    await setInstantUnstakeParamsByGovernance({
      feeRecipient: { 0: feeRecipientKeypair.publicKey },
    });

    const userATABalanceBefore = await getTokenBalance(user.userATA);
    const feeRecipientBalanceBefore = await getTokenBalance(feeRecipientATA);
    const lockerStateBefore = await user.voterProgram.account.locker.fetch(
      locker
    );

    await user.voterProgram.methods
      .instantUnstake(instantUnstakeAmount)
      .accounts({
        locker,
        escrow: user.escrow,
        config: instantUnstakeConfig,
        owner: user.userWallet.publicKey,
        escrowTokens: user.escrowATA,
        destinationTokens: user.userATA,
        feeRecipientTokens: feeRecipientATA,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const escrowStateAfter = await user.voterProgram.account.escrow.fetch(
      user.escrow
    );
    const lockerStateAfter = await user.voterProgram.account.locker.fetch(
      locker
    );
    const userATABalanceAfter = await getTokenBalance(user.userATA);
    const feeRecipientBalanceAfter = await getTokenBalance(feeRecipientATA);

    expect(escrowStateAfter.amount.toString()).to.equal(
      lockAmount.sub(instantUnstakeAmount).toString()
    );
    expect(
      lockerStateBefore.lockedSupply
        .sub(lockerStateAfter.lockedSupply)
        .toString()
    ).to.equal(instantUnstakeAmount.toString());
    expect(userATABalanceAfter.sub(userATABalanceBefore).toString()).to.equal(
      instantUnstakeAmount.toString()
    );
    expect(
      feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore).toString()
    ).to.equal("0");
  });

  it("users instant unstake with penalty", async () => {
    const user = await createFundedUserEscrow(lockAmount);
    const feeRecipientATA = await getOrCreateATA(
      rewardMint,
      feeRecipientKeypair.publicKey,
      keypair,
      provider.connection
    );
    const expectedPenalty = new BN(100);
    const expectedNetAmount = new BN(300);

    await setInstantUnstakeParamsByGovernance({ enable: {} }).catch(
      () => undefined
    );
    await setInstantUnstakeParamsByGovernance({
      penaltyBps: { 0: defaultPenaltyBps },
    });
    await setInstantUnstakeParamsByGovernance({
      feeRecipient: { 0: feeRecipientKeypair.publicKey },
    });

    const userATABalanceBefore = await getTokenBalance(user.userATA);
    const feeRecipientBalanceBefore = await getTokenBalance(feeRecipientATA);
    const lockerStateBefore = await user.voterProgram.account.locker.fetch(
      locker
    );

    await user.voterProgram.methods
      .instantUnstake(instantUnstakeAmount)
      .accounts({
        locker,
        escrow: user.escrow,
        config: instantUnstakeConfig,
        owner: user.userWallet.publicKey,
        escrowTokens: user.escrowATA,
        destinationTokens: user.userATA,
        feeRecipientTokens: feeRecipientATA,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const escrowStateAfter = await user.voterProgram.account.escrow.fetch(
      user.escrow
    );
    const lockerStateAfter = await user.voterProgram.account.locker.fetch(
      locker
    );
    const userATABalanceAfter = await getTokenBalance(user.userATA);
    const feeRecipientBalanceAfter = await getTokenBalance(feeRecipientATA);

    expect(escrowStateAfter.amount.toString()).to.equal(
      lockAmount.sub(instantUnstakeAmount).toString()
    );
    expect(
      lockerStateBefore.lockedSupply
        .sub(lockerStateAfter.lockedSupply)
        .toString()
    ).to.equal(instantUnstakeAmount.toString());
    expect(userATABalanceAfter.sub(userATABalanceBefore).toString()).to.equal(
      expectedNetAmount.toString()
    );
    expect(
      feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore).toString()
    ).to.equal(expectedPenalty.toString());
  });
});
