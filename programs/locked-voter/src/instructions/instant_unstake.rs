use crate::*;
use anchor_spl::token;

/// Accounts for [voter::instant_unstake].
#[derive(Accounts)]
pub struct InstantUnstake<'info> {
    /// The [Locker].
    #[account(mut)]
    pub locker: Box<Account<'info, Locker>>,

    /// The [Escrow] being instant-unstaked from.
    #[account(mut, has_one = locker, has_one = owner)]
    pub escrow: Box<Account<'info, Escrow>>,

    /// The [InstantUnstakeConfig] for this locker.
    #[account(has_one = locker)]
    pub config: Box<Account<'info, InstantUnstakeConfig>>,

    /// Authority of the [Escrow].
    pub owner: Signer<'info>,

    /// Tokens locked up in the [Escrow].
    #[account(mut, constraint = escrow.tokens == escrow_tokens.key())]
    pub escrow_tokens: Account<'info, TokenAccount>,

    /// Destination for the tokens to receive (amount minus penalty).
    #[account(mut)]
    pub destination_tokens: Account<'info, TokenAccount>,

    /// Token account that receives the penalty fee.
    /// Owner must match the fee_recipient configured in [InstantUnstakeConfig].
    #[account(
        mut,
        associated_token::mint = escrow_tokens.mint,
        associated_token::authority = config.fee_recipient
    )]
    pub fee_recipient_tokens: Account<'info, TokenAccount>,

    /// Token program.
    pub token_program: Program<'info, Token>,
}

impl<'info> InstantUnstake<'info> {
    pub fn instant_unstake(&mut self, amount: u64) -> Result<()> {
        require!(self.config.enabled, ErrorCode::InstantUnstakeDisabled);
        require!(amount > 0, ErrorCode::AmountIsZero);
        require!(
            amount <= self.escrow.amount,
            ErrorCode::InvalidAmountForPartialUnstaking
        );

        let penalty_amount: u64 = {
            let raw = unwrap_int!((amount as u128)
                .checked_mul(self.config.instant_penalty_bps as u128));
            let divided = unwrap_int!(raw.checked_div(10_000));
            unwrap_int!(u64::try_from(divided).ok())
        };
        let net_amount = unwrap_int!(amount.checked_sub(penalty_amount));

        let seeds: &[&[&[u8]]] = escrow_seeds!(self.escrow);

        if net_amount > 0 {
            token::transfer(
                CpiContext::new(
                    self.token_program.to_account_info(),
                    token::Transfer {
                        from: self.escrow_tokens.to_account_info(),
                        to: self.destination_tokens.to_account_info(),
                        authority: self.escrow.to_account_info(),
                    },
                )
                .with_signer(seeds),
                net_amount,
            )?;
        }

        if penalty_amount > 0 {
            token::transfer(
                CpiContext::new(
                    self.token_program.to_account_info(),
                    token::Transfer {
                        from: self.escrow_tokens.to_account_info(),
                        to: self.fee_recipient_tokens.to_account_info(),
                        authority: self.escrow.to_account_info(),
                    },
                )
                .with_signer(seeds),
                penalty_amount,
            )?;
        }

        self.escrow.amount = unwrap_int!(self.escrow.amount.checked_sub(amount));

        let locker = &mut self.locker;
        locker.locked_supply = unwrap_int!(locker.locked_supply.checked_sub(amount));

        emit!(InstantUnstakeEvent {
            escrow_owner: self.escrow.owner,
            locker: locker.key(),
            config: self.config.key(),
            amount,
            penalty_amount,
            net_amount,
            fee_recipient: self.config.fee_recipient,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

impl<'info> Validate<'info> for InstantUnstake<'info> {
    fn validate(&self) -> Result<()> {
        assert_keys_eq!(self.locker, self.escrow.locker);
        assert_keys_neq!(self.escrow_tokens, self.destination_tokens);
        assert_keys_neq!(self.escrow_tokens, self.fee_recipient_tokens);
        Ok(())
    }
}

#[event]
/// Event called in [voter::instant_unstake].
pub struct InstantUnstakeEvent {
    /// The owner of the [Escrow].
    #[index]
    pub escrow_owner: Pubkey,
    /// The [Locker].
    #[index]
    pub locker: Pubkey,
    /// The [InstantUnstakeConfig] used.
    pub config: Pubkey,
    /// Total amount unstaked from the escrow.
    pub amount: u64,
    /// Penalty amount sent to fee recipient.
    pub penalty_amount: u64,
    /// Net amount sent to destination (amount - penalty).
    pub net_amount: u64,
    /// Fee recipient token account.
    pub fee_recipient: Pubkey,
    /// Timestamp of the event.
    pub timestamp: i64,
}
