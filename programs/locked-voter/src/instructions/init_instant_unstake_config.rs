use crate::*;

/// Accounts for [voter::init_instant_unstake_config].
#[derive(Accounts)]
pub struct InitInstantUnstakeConfig<'info> {
    /// The [Locker].
    #[account(mut)]
    pub locker: Box<Account<'info, Locker>>,

    /// The [InstantUnstakeConfig] PDA to initialize.
    #[account(
        init,
        seeds = [
            b"InstantUnstakeConfig".as_ref(),
            locker.key().as_ref()
        ],
        bump,
        payer = payer,
        space = 8 + InstantUnstakeConfig::LEN
    )]
    pub config: Account<'info, InstantUnstakeConfig>,

    /// The [Governor].
    pub governor: Box<Account<'info, Governor>>,

    /// The smart wallet on the [Governor].
    pub smart_wallet: Signer<'info>,

    /// Payer of the initialization.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// System program.
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InstantUnstakeParams {
    /// Whether instant unstaking is enabled.
    pub enabled: bool,
    /// Penalty in basis points for instant unstake (max 10000).
    pub instant_penalty_bps: u16,
    /// Token account that receives penalty fees.
    pub fee_recipient: Pubkey,
}

impl<'info> InitInstantUnstakeConfig<'info> {
    pub fn init_instant_unstake_config(
        &mut self,
        bump: u8,
        params: InstantUnstakeParams,
    ) -> Result<()> {
        require!(
            params.instant_penalty_bps <= 10_000,
            ErrorCode::InvalidPenaltyBps
        );
        require!(params.fee_recipient != Pubkey::default(), ErrorCode::InvalidFeeRecipient);

        let config = &mut self.config;
        config.locker = self.locker.key();
        config.bump = bump;
        config.enabled = params.enabled;
        config.instant_penalty_bps = params.instant_penalty_bps;
        config.fee_recipient = params.fee_recipient;

        emit!(InitInstantUnstakeConfigEvent {
            locker: self.locker.key(),
            config: config.key(),
            params,
        });

        Ok(())
    }
}

impl<'info> Validate<'info> for InitInstantUnstakeConfig<'info> {
    fn validate(&self) -> Result<()> {
        assert_keys_eq!(self.governor, self.locker.governor, "governor mismatch");
        assert_keys_eq!(self.smart_wallet, self.governor.smart_wallet);
        Ok(())
    }
}

#[event]
/// Event called in [voter::init_instant_unstake_config].
pub struct InitInstantUnstakeConfigEvent {
    /// The [Locker].
    #[index]
    pub locker: Pubkey,
    /// The [InstantUnstakeConfig].
    pub config: Pubkey,
    /// The params set.
    pub params: InstantUnstakeParams,
}
