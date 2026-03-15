use crate::*;

/// Accounts for [voter::set_instant_unstake_params].
#[derive(Accounts)]
pub struct SetInstantUnstakeParams<'info> {
    /// The [Locker].
    pub locker: Box<Account<'info, Locker>>,

    /// The [InstantUnstakeConfig] to update.
    #[account(mut, has_one = locker)]
    pub config: Account<'info, InstantUnstakeConfig>,

    /// The [Governor].
    pub governor: Box<Account<'info, Governor>>,

    /// The smart wallet on the [Governor].
    pub smart_wallet: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstantUnstakeUpdateParams {
    Enable,
    Disable,
    PenaltyBps(u16),
    FeeRecipient(Pubkey),
}

impl<'info> SetInstantUnstakeParams<'info> {
    pub fn set_instant_unstake_params(&mut self, params: InstantUnstakeUpdateParams) -> Result<()> {
        let config = &mut self.config;
        let prev_params = InstantUnstakeParams {
            enabled: config.enabled,
            instant_penalty_bps: config.instant_penalty_bps,
            fee_recipient: config.fee_recipient,
        };

        match params {
            InstantUnstakeUpdateParams::Enable => {
                require!(config.enabled == false, ErrorCode::InstantUnstakeAlreadyEnabled);
                config.enabled = true;
            }
            InstantUnstakeUpdateParams::Disable => {
                require!(config.enabled == true, ErrorCode::InstantUnstakeAlreadyDisabled);
                config.enabled = false;
            }
            InstantUnstakeUpdateParams::PenaltyBps(penalty_bps) => {
                require!(penalty_bps <= 10_000, ErrorCode::InvalidPenaltyBps);
                config.instant_penalty_bps = penalty_bps;
            }
            InstantUnstakeUpdateParams::FeeRecipient(fee_recipient) => {
                require!(fee_recipient != Pubkey::default(), ErrorCode::InvalidFeeRecipient);
                config.fee_recipient = fee_recipient;
            }
        }

        let new_params = InstantUnstakeParams {
            enabled: config.enabled,
            instant_penalty_bps: config.instant_penalty_bps,
            fee_recipient: config.fee_recipient,
        };

        emit!(SetInstantUnstakeParamsEvent {
            locker: self.locker.key(),
            config: config.key(),
            prev_params,
            params: new_params,
        });

        Ok(())
    }
}

impl<'info> Validate<'info> for SetInstantUnstakeParams<'info> {
    fn validate(&self) -> Result<()> {
        assert_keys_eq!(self.governor, self.locker.governor, "governor mismatch");
        assert_keys_eq!(self.smart_wallet, self.governor.smart_wallet);
        Ok(())
    }
}

#[event]
/// Event called in [voter::set_instant_unstake_params].
pub struct SetInstantUnstakeParamsEvent {
    /// The [Locker].
    #[index]
    pub locker: Pubkey,
    /// The [InstantUnstakeConfig].
    pub config: Pubkey,
    /// Previous params.
    pub prev_params: InstantUnstakeParams,
    /// New params.
    pub params: InstantUnstakeParams,
}
